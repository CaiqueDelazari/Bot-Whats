const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
// Pasta raiz das sessões. Na Railway, aponte para um Volume persistente
// (ex: /data) definindo AUTH_DIR — senão os QRs precisam ser reescaneados
// a cada restart. Cada cliente vira uma subpasta dentro daqui.
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
// Token de segurança: se definido, o /send exige Authorization: Bearer <token>.
const BOT_TOKEN = process.env.BOT_TOKEN || "";
// Tempo mínimo (minutos) entre auto-respostas para o MESMO contato, para não
// responder toda mensagem numa conversa. 0 = responde sempre. Padrão: 6h.
const COOLDOWN_MIN = Number(process.env.AUTOREPLY_COOLDOWN_MIN ?? 360);

// Uma sessão por cliente/número. sessionId -> { sock, isConnected, lastQR }
const sessions = new Map();
// Última auto-resposta por contato: "sessionId:jid" -> timestamp.
const lastReply = new Map();

// Buffer de debug em memória (últimas N linhas) — exposto em GET /debug pra
// diagnosticar à distância sem precisar dos logs do Railway.
const debugLog = [];
function dbg(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  debugLog.push(`${stamp} ${line}`);
  if (debugLog.length > 200) debugLog.shift();
  console.log(line);
}

// Extrai o texto de uma mensagem, lidando com os vários invólucros do WhatsApp
// (efêmera, ver-uma-vez, legenda de imagem/vídeo, respostas de botão/lista).
function extractText(message) {
  if (!message) return "";
  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}

// Mantém só letras, números, hífen e underscore — evita path traversal.
function sanitize(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

// Config de auto-resposta por sessão (salva em disco, junto do Volume).
function configPath(sessionId) {
  return path.join(AUTH_DIR, `${sessionId}.config.json`);
}
function getConfig(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(configPath(sessionId), "utf8"));
  } catch {
    return { autoReplyEnabled: false, autoReplyMessage: "" };
  }
}
function saveConfig(sessionId, cfg) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(configPath(sessionId), JSON.stringify(cfg, null, 2));
}

async function startSession(sessionId) {
  let session = sessions.get(sessionId);
  // Já está rodando OU em pleno processo de subir um socket: não cria outro.
  // Dois sockets com a mesma credencial = "conflito" pro WhatsApp, que desloga
  // o aparelho. Esse guard (junto com o teardown no "close") é o que evita o
  // ciclo de deslogamento.
  if (session?.sock || session?.connecting) return session;
  if (!session) {
    session = { sock: null, isConnected: false, lastQR: null, connecting: false, retries: 0, lastActivity: Date.now(), staleStrikes: 0 };
    sessions.set(sessionId, session);
  }
  session.connecting = true;

  const authPath = path.join(AUTH_DIR, sessionId);
  let state, saveCreds, version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authPath));
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    // Falha ao iniciar (ex.: sem rede): libera o guard e tenta de novo depois.
    session.connecting = false;
    const delay = Math.min(30000, 2000 * 2 ** (session.retries || 0));
    session.retries = (session.retries || 0) + 1;
    console.error(`[${sessionId}] erro ao iniciar (${err.message}), tentando em ${Math.round(delay / 1000)}s...`);
    setTimeout(() => startSession(sessionId), delay);
    return session;
  }
  const logger = P({ level: "silent" });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Cache das chaves de sinal: menos erros de descriptografia e instabilidade.
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    // Identidade de navegador FIXA — o WhatsApp reconhece sempre o mesmo
    // aparelho a cada reconexão, em vez de tratar como dispositivo novo.
    browser: Browsers.ubuntu("Chrome"),
    // Não rouba a presença "online" do celular (evita briga de presença).
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
  });
  session.sock = sock;
  session.connecting = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // Qualquer evento de conexão conta como "sinal de vida" pro watchdog.
    session.lastActivity = Date.now();
    if (qr) {
      session.lastQR = qr;
      console.log(`[${sessionId}] QR Code gerado — abra /connect/${sessionId} para escanear`);
    }

    if (connection === "close") {
      session.isConnected = false;
      session.sock = null;
      // Desliga de vez o socket morto: sem isso, eventos atrasados dele
      // disparam reconexões paralelas e viram socket duplicado (= logout).
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.end?.(); } catch {}

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`[${sessionId}] logout de verdade. Limpando credenciais — reescaneie em /connect/${sessionId}`);
        sessions.delete(sessionId);
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
      } else {
        // Reconexão com backoff exponencial (2s, 4s, 8s… teto 30s) para não
        // martelar o servidor do WhatsApp numa queda transitória.
        const delay = Math.min(30000, 2000 * 2 ** (session.retries || 0));
        session.retries = (session.retries || 0) + 1;
        console.log(`[${sessionId}] conexão caiu (code=${code}), reconectando em ${Math.round(delay / 1000)}s...`);
        setTimeout(() => startSession(sessionId), delay);
      }
    }

    if (connection === "open") {
      session.isConnected = true;
      session.lastQR = null;
      session.retries = 0;
      session.staleStrikes = 0;
      session.lastActivity = Date.now();
      console.log(`[${sessionId}] ✅ conectado ao WhatsApp!`);
    }
  });

  // Auto-resposta: quando um cliente manda mensagem, responde com o link/cardápio.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Recebeu mensagem = socket vivo. Zera o relógio do watchdog.
    session.lastActivity = Date.now();
    session.staleStrikes = 0;
    const cfg = getConfig(sessionId);
    for (const msg of messages) {
      const jid = msg.key?.remoteJid || "";
      const text = extractText(msg.message);
      // Log de TUDO que chega — é o que permite diagnosticar via /debug.
      dbg(
        `[${sessionId}] upsert type=${type} from=${jid} fromMe=${!!msg.key?.fromMe} ` +
          `hasMsg=${!!msg.message} keys=${msg.message ? Object.keys(msg.message).join(",") : "-"} ` +
          `text="${text.slice(0, 40)}"`
      );

      if (type !== "notify") continue; // histórico/sincronização: não responde
      if (!cfg.autoReplyEnabled || !cfg.autoReplyMessage) {
        dbg(`[${sessionId}] skip: auto-resposta desligada`);
        continue;
      }
      if (msg.key?.fromMe) continue; // mensagem minha
      if (jid.endsWith("@g.us")) continue; // grupo
      if (jid === "status@broadcast") continue; // status
      if (!text) {
        dbg(`[${sessionId}] skip: sem texto (tipo não suportado)`);
        continue;
      }

      // Cooldown: não responde o mesmo contato de novo dentro da janela.
      const key = `${sessionId}:${jid}`;
      const now = Date.now();
      if (COOLDOWN_MIN > 0) {
        const last = lastReply.get(key) || 0;
        if (now - last < COOLDOWN_MIN * 60 * 1000) {
          dbg(`[${sessionId}] skip: cooldown ativo para ${jid}`);
          continue;
        }
      }
      lastReply.set(key, now);

      try {
        await sock.sendMessage(jid, { text: cfg.autoReplyMessage });
        dbg(`[${sessionId}] ✅ auto-resposta ENVIADA para ${jid}`);
      } catch (err) {
        dbg(`[${sessionId}] ❌ erro na auto-resposta: ${err.message}`);
      }
    }
  });

  return session;
}

// Ao iniciar, reconecta automaticamente todas as sessões já salvas no disco.
function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const dirs = fs
    .readdirSync(AUTH_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const id of dirs) {
    console.log(`Restaurando sessão salva: ${id}`);
    startSession(id);
  }
}

// ── Watchdog anti-sessão-zumbi ─────────────────────────────────────────────
// Problema: às vezes o socket de uma sessão "morre" em silêncio — o WhatsApp
// para de entregar mensagens, mas o Baileys nunca dispara o evento "close".
// A sessão fica isConnected=true, sem receber nem enviar nada ("travou").
// Solução: se uma sessão passar STALE minutos sem NENHUM evento, fazemos uma
// sondagem ativa (round-trip real ao servidor). Se ela falhar/expirar, o socket
// está morto → reiniciamos ele reusando a credencial salva em disco (SEM QR).
const WATCHDOG_STALE_MS =
  Number(process.env.WATCHDOG_STALE_MIN || 5) * 60 * 1000;
const WATCHDOG_CHECK_MS =
  Number(process.env.WATCHDOG_CHECK_SEC || 60) * 1000;
const WATCHDOG_PROBE_TIMEOUT_MS =
  Number(process.env.WATCHDOG_PROBE_TIMEOUT_SEC || 12) * 1000;

// Sondagem de vida: faz um onWhatsApp do próprio número (round-trip ao servidor)
// com timeout. Resolve = socket vivo; throw/timeout = socket morto.
async function probeAlive(sock) {
  const id = sock?.user?.id;
  if (!id) return false;
  const num = id.split(":")[0].split("@")[0];
  try {
    const res = await Promise.race([
      sock.onWhatsApp(num),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("probe timeout")), WATCHDOG_PROBE_TIMEOUT_MS)
      ),
    ]);
    return Array.isArray(res);
  } catch {
    return false;
  }
}

// Reinicia o socket de uma sessão sem apagar credencial (diferente do /reset).
function restartSocket(sessionId, session) {
  const sock = session.sock;
  try { sock?.ev?.removeAllListeners?.(); } catch {}
  try { sock?.end?.(); } catch {}
  session.sock = null;
  session.isConnected = false;
  session.connecting = false;
  startSession(sessionId);
}

let watchdogRunning = false;
async function watchdogTick() {
  if (watchdogRunning) return; // evita sobreposição se uma passada demorar
  watchdogRunning = true;
  try {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      // Só vigia sessões que se dizem conectadas e não estão subindo agora.
      if (!session.isConnected || !session.sock || session.connecting) continue;
      if (now - (session.lastActivity || 0) < WATCHDOG_STALE_MS) continue;

      const alive = await probeAlive(session.sock);
      if (alive) {
        // Estava só ociosa (sem mensagens), mas viva. Zera o relógio.
        session.lastActivity = Date.now();
        session.staleStrikes = 0;
        continue;
      }

      // Exige 2 falhas seguidas antes de reiniciar, pra não derrubar por uma
      // sondagem lenta isolada.
      session.staleStrikes = (session.staleStrikes || 0) + 1;
      const min = Math.round((now - (session.lastActivity || 0)) / 60000);
      if (session.staleStrikes < 2) {
        dbg(`[${sessionId}] watchdog: sem resposta há ${min}min (aviso ${session.staleStrikes}/2)`);
        continue;
      }
      session.staleStrikes = 0;
      dbg(`[${sessionId}] watchdog: sessão zumbi (${min}min sem responder) — reiniciando socket SEM QR`);
      restartSocket(sessionId, session);
    }
  } finally {
    watchdogRunning = false;
  }
}

// Normaliza telefone brasileiro e resolve o JID real (trata o 9º dígito).
async function resolveJid(sock, phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 11) digits = "55" + digits; // adiciona código do Brasil
  const results = await sock.onWhatsApp(digits);
  const hit = results?.[0];
  return hit?.exists ? hit.jid : null;
}

// ── Pesquisa de satisfação (agendada) ─────────────────────────────────────
// O site chama /schedule-survey ao criar o pedido; o bot envia a mensagem X
// minutos depois (padrão 1h30). A fila é gravada no AUTH_DIR (Volume da
// Railway), então sobrevive a restart/deploy. É por sessão: cada pedido guarda
// de qual cliente (session) a pesquisa deve sair.
const SURVEY_DELAY_MIN = Number(process.env.SURVEY_DELAY_MIN || 90); // 1h30
const SURVEY_MAX_LATE_MS =
  Number(process.env.SURVEY_MAX_LATE_MIN || 180) * 60 * 1000;
const SURVEY_FILE = path.join(AUTH_DIR, "surveys.json");

let pendingSurveys = [];        // [{ session, phone, orderId, message, dueAt }]
const surveyTimers = new Map(); // orderId -> handle do setTimeout

function loadSurveys() {
  try {
    const data = JSON.parse(fs.readFileSync(SURVEY_FILE, "utf8"));
    pendingSurveys = Array.isArray(data) ? data : [];
  } catch {
    pendingSurveys = [];
  }
}

function saveSurveys() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(SURVEY_FILE, JSON.stringify(pendingSurveys, null, 2));
  } catch (err) {
    console.error("[survey] erro ao salvar:", err.message);
  }
}

function removeSurvey(orderId) {
  pendingSurveys = pendingSurveys.filter((s) => s.orderId !== orderId);
  saveSurveys();
  const t = surveyTimers.get(orderId);
  if (t) { clearTimeout(t); surveyTimers.delete(orderId); }
}

async function sendSurvey(sv) {
  let session = sessions.get(sv.session);
  if (!session) session = await startSession(sv.session);
  // Sessão ainda não conectada → mantém na fila e tenta de novo em 1 min.
  if (!session.isConnected || !session.sock) {
    surveyTimers.set(sv.orderId, setTimeout(() => sendSurvey(sv), 60 * 1000));
    return;
  }
  try {
    const jid = await resolveJid(session.sock, sv.phone);
    if (jid) {
      await session.sock.sendMessage(jid, { text: sv.message });
      dbg(`[${sv.session}] pesquisa enviada para ${jid} (pedido ${sv.orderId})`);
    } else {
      dbg(`[${sv.session}] pesquisa não enviada: ${sv.phone} sem WhatsApp`);
    }
  } catch (err) {
    dbg(`[${sv.session}] erro ao enviar pesquisa: ${err.message}`);
  } finally {
    removeSurvey(sv.orderId);
  }
}

function scheduleSurvey(sv) {
  const delay = sv.dueAt - Date.now();
  if (delay <= 0) {
    // Passou da hora (bot ficou offline). Envia se não atrasou demais; senão
    // descarta, pra não mandar pesquisa em hora estranha.
    if (Date.now() - sv.dueAt > SURVEY_MAX_LATE_MS) removeSurvey(sv.orderId);
    else sendSurvey(sv);
    return;
  }
  surveyTimers.set(sv.orderId, setTimeout(() => sendSurvey(sv), delay));
}

// ── Rotas ────────────────────────────────────────────────────────────────

// Verifica o token (quando BOT_TOKEN está definido). Retorna true se ok.
function checkToken(req) {
  if (!BOT_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === BOT_TOKEN;
}

// Lê a config de auto-resposta de uma sessão.
app.get("/config/:sessionId", (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: "Não autorizado" });
  const sessionId = sanitize(req.params.sessionId);
  res.json(getConfig(sessionId));
});

// Define a auto-resposta. Body: { autoReplyEnabled, autoReplyMessage }
app.post("/config/:sessionId", (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: "Não autorizado" });
  const sessionId = sanitize(req.params.sessionId);
  if (!sessionId) return res.status(400).json({ error: "Sessão inválida" });
  const cfg = {
    autoReplyEnabled: Boolean(req.body.autoReplyEnabled),
    autoReplyMessage: String(req.body.autoReplyMessage || ""),
  };
  saveConfig(sessionId, cfg);
  res.json({ ok: true, config: cfg });
});

// Envio de mensagem. Body: { session, phone, message }
app.post("/send", async (req, res) => {
  if (!checkToken(req)) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  const sessionId = sanitize(req.body.session);
  const { phone, message } = req.body;
  if (!sessionId || !phone || !message) {
    return res.status(400).json({ error: "session, phone e message são obrigatórios" });
  }

  let session = sessions.get(sessionId);
  if (!session) session = await startSession(sessionId);

  if (!session.isConnected || !session.sock) {
    return res
      .status(503)
      .json({ error: `Sessão "${sessionId}" não conectada. Abra /connect/${sessionId}` });
  }

  try {
    const jid = await resolveJid(session.sock, phone);
    if (!jid) {
      console.log(`[${sessionId}] número sem WhatsApp ou inválido: ${phone}`);
      return res.status(404).json({ error: "Número não encontrado no WhatsApp" });
    }
    await session.sock.sendMessage(jid, { text: message });
    console.log(`[${sessionId}] mensagem enviada para ${jid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${sessionId}] erro ao enviar:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Agendar pesquisa de satisfação. Body: { session, phone, orderId, message, delayMin? }
// O site compõe a mensagem (sabe o nome do restaurante) e o bot só segura o
// tempo e envia. delayMin é opcional (padrão SURVEY_DELAY_MIN = 90 = 1h30).
app.post("/schedule-survey", (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ error: "Não autorizado" });
  const sessionId = sanitize(req.body.session);
  const { phone, orderId, message } = req.body;
  const delayMin =
    Number(req.body.delayMin) > 0 ? Number(req.body.delayMin) : SURVEY_DELAY_MIN;
  if (!sessionId || !phone || !orderId || !message) {
    return res
      .status(400)
      .json({ error: "session, phone, orderId e message são obrigatórios" });
  }
  // Evita agendar o mesmo pedido duas vezes.
  if (pendingSurveys.some((s) => s.orderId === String(orderId))) {
    return res.json({ ok: true, already: true });
  }
  const sv = {
    session: sessionId,
    phone: String(phone),
    orderId: String(orderId),
    message: String(message),
    dueAt: Date.now() + delayMin * 60 * 1000,
  };
  pendingSurveys.push(sv);
  saveSurveys();
  scheduleSurvey(sv);
  dbg(`[${sessionId}] pesquisa agendada p/ ${phone} em ${delayMin}min (pedido ${orderId})`);
  res.json({ ok: true });
});

// Debug: últimas linhas de log em memória (pra diagnosticar à distância).
app.get("/debug", (req, res) => {
  res.type("text/plain").send(debugLog.join("\n") || "(sem eventos ainda)");
});

// Reset: força re-pareamento. Desloga de verdade, apaga as credenciais
// quebradas e sobe a sessão limpa pra gerar um QR novo. Usar quando a sessão
// fica "zumbi" (envia mas não recebe). Redireciona pro QR.
app.get("/reset/:sessionId", async (req, res) => {
  const sessionId = sanitize(req.params.sessionId);
  if (!sessionId) return res.status(400).send("Sessão inválida");
  const session = sessions.get(sessionId);
  try { await session?.sock?.logout?.(); } catch {}
  try { session?.sock?.ev?.removeAllListeners?.(); } catch {}
  try { session?.sock?.end?.(); } catch {}
  sessions.delete(sessionId);
  try { fs.rmSync(path.join(AUTH_DIR, sessionId), { recursive: true, force: true }); } catch {}
  dbg(`[${sessionId}] RESET manual — credenciais apagadas, gerando QR novo`);
  startSession(sessionId);
  res.send(
    `<html><head><meta http-equiv="refresh" content="3;url=/connect/${sessionId}"></head>
     <body style="font-family:sans-serif;text-align:center;padding:40px">
     <h2>Sessão "${sessionId}" resetada 🔄</h2>
     <p>Indo pro QR Code novo... escaneie com o WhatsApp do Mets.</p>
     <p><a href="/connect/${sessionId}">Clique aqui se não redirecionar</a></p>
     </body></html>`
  );
});

// Status de uma sessão (JSON).
app.get("/status/:sessionId", (req, res) => {
  const sessionId = sanitize(req.params.sessionId);
  const session = sessions.get(sessionId);
  res.json({ session: sessionId, connected: Boolean(session?.isConnected) });
});

// Página para conectar uma sessão (mostra o QR Code).
app.get("/connect/:sessionId", async (req, res) => {
  const sessionId = sanitize(req.params.sessionId);
  if (!sessionId) return res.status(400).send("Sessão inválida");

  let session = sessions.get(sessionId);
  if (!session?.sock) session = await startSession(sessionId);

  if (session.isConnected) {
    return res.send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>✅ "${sessionId}" conectado ao WhatsApp</h2>
       <p>Tudo certo! As mensagens automáticas estão funcionando.</p>
       </body></html>`
    );
  }
  if (!session.lastQR) {
    return res.send(
      `<html><head><meta http-equiv="refresh" content="3"></head>
       <body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>Gerando QR Code de "${sessionId}"...</h2>
       <p>Aguarde alguns segundos. A página atualiza sozinha.</p>
       </body></html>`
    );
  }
  try {
    const dataUrl = await QRCode.toDataURL(session.lastQR, { width: 300 });
    res.send(
      `<html><head><meta http-equiv="refresh" content="20"></head>
       <body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>Conectar "${sessionId}"</h2>
       <p>WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
       <img src="${dataUrl}" alt="QR Code" />
       <p style="color:#888">A página atualiza sozinha quando conectar.</p>
       </body></html>`
    );
  } catch (err) {
    res.status(500).send("Erro ao gerar QR Code");
  }
});

// Página inicial: lista as sessões e o estado de cada uma.
app.get("/", (req, res) => {
  const rows = [...sessions.entries()]
    .map(
      ([id, s]) =>
        `<tr><td>${id}</td><td>${s.isConnected ? "✅ conectado" : "⚠️ desconectado"}</td>
         <td><a href="/connect/${id}">conectar</a></td></tr>`
    )
    .join("");
  res.send(
    `<html><body style="font-family:sans-serif;padding:40px">
     <h2>Bot WhatsApp — sessões</h2>
     <p>Para conectar um cliente novo, abra <code>/connect/ID-DO-CLIENTE</code></p>
     <table border="1" cellpadding="8" style="border-collapse:collapse">
       <tr><th>Sessão</th><th>Status</th><th></th></tr>
       ${rows || '<tr><td colspan="3">Nenhuma sessão ativa</td></tr>'}
     </table>
     </body></html>`
  );
});

app.listen(PORT, () => {
  console.log(`Bot rodando na porta ${PORT}`);
  restoreSessions();
  // Recarrega as pesquisas de satisfação pendentes e reprograma os envios.
  loadSurveys();
  for (const sv of pendingSurveys) scheduleSurvey(sv);
  // Vigia sessões zumbi e reconecta sozinho (sem QR).
  setInterval(watchdogTick, WATCHDOG_CHECK_MS);
  console.log(
    `Watchdog ativo: sonda sessões paradas há >${WATCHDOG_STALE_MS / 60000}min a cada ${WATCHDOG_CHECK_MS / 1000}s`
  );
});
