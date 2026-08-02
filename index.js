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
} = require("baileys");
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

// ── Versão do protocolo do WhatsApp Web ─────────────────────────────────────
// Era buscada A CADA startSession. Duas armadilhas nisso:
//  1. `fetchLatestBaileysVersion()` NÃO propaga erro de rede: no catch ele
//     devolve a versão embutida na lib com `isLatest:false`, calado. Como o bot
//     ignorava esse campo, uma sessão que subiu durante uma oscilação de rede
//     passava a rodar num protocolo DIFERENTE das outras — no mesmo processo,
//     sem nada no log dizendo isso.
//  2. Reconexão do watchdog re-buscava a versão. Uma sessão que reconectasse
//     depois de a WhatsApp publicar uma versão nova ficava dessincronizada das
//     demais sem ninguém ter mexido em nada.
// Agora é buscada UMA vez, no boot, e compartilhada por todas as sessões. Dá
// pra fixar com WA_VERSION="2.3000.1023223821" se uma versão nova quebrar algo.
//
// O cache guarda a PROMESSA, não o valor resolvido. Guardando o valor, o
// restoreSessions() do boot chamava startSession() de todas as sessões em
// sequência e cada uma passava pelo `if` antes de a primeira busca terminar —
// resultado: N buscas em paralelo, que é exatamente o que isso veio evitar.
// Com a promessa, quem chega depois espera a mesma busca.
let waVersionPromise = null;
function getWAVersion() {
  if (!waVersionPromise) waVersionPromise = resolveWAVersion();
  return waVersionPromise;
}

async function resolveWAVersion() {
  const pin = String(process.env.WA_VERSION || "").trim();
  if (pin) {
    const parts = pin.split(".").map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      dbg(`Versão do WhatsApp Web FIXADA por WA_VERSION: ${parts.join(".")}`);
      return parts;
    }
    dbg(`⚠️ WA_VERSION inválida ("${pin}") — ignorando e buscando a atual.`);
  }
  const { version, isLatest } = await fetchLatestBaileysVersion();
  dbg(
    `Versão do WhatsApp Web: ${version.join(".")} ` +
      (isLatest ? "(buscada agora)" : "⚠️ (FALLBACK embutido — a busca falhou)")
  );
  return version;
}

async function startSession(sessionId) {
  let session = sessions.get(sessionId);
  // Já está rodando OU em pleno processo de subir um socket: não cria outro.
  // Dois sockets com a mesma credencial = "conflito" pro WhatsApp, que desloga
  // o aparelho. Esse guard (junto com o teardown no "close") é o que evita o
  // ciclo de deslogamento.
  if (session?.sock || session?.connecting) return session;
  if (!session) {
    session = {
      sock: null,
      isConnected: false,
      lastQR: null,
      connecting: false,
      retries: 0,
      watchdogStrikes: 0, // reconexões seguidas do watchdog que não resolveram
    };
    sessions.set(sessionId, session);
  }
  session.connecting = true;

  const authPath = path.join(AUTH_DIR, sessionId);
  let state, saveCreds;
  const version = await getWAVersion();
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(authPath));
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
    // Não baixar o histórico inteiro (anos de conversa) continua sendo o certo.
    syncFullHistory: false,
    // ...MAS é obrigatório passar esta função junto. O Socket/index.js do
    // Baileys sobrescreve o padrão da lib (`() => true`) por
    // `() => !!syncFullHistory` quando a gente não passa a nossa — ou seja,
    // com syncFullHistory:false ele passa a REJEITAR todo history sync,
    // inclusive o INITIAL_BOOTSTRAP, por onde chega o estado inicial dos chats.
    // Aceitar os tipos de sync não baixa histórico. Responder mensagem velha
    // não é risco: a auto-resposta exige type "notify", e histórico não vem
    // como notify.
    shouldSyncHistoryMessage: () => true,
  });
  session.sock = sock;
  session.connecting = false;

  sock.ev.on("creds.update", saveCreds);

  // ── Batimento de recebimento (é o que alimenta o watchdog) ───────────────
  // QUALQUER evento vindo do WhatsApp conta como "a sessão ainda ouve". Antes
  // só messages.upsert contava, e isso dava falso positivo em série: numa loja
  // parada não chega mensagem nenhuma por 15min e a sessão saudável levava
  // reconexão à toa — de novo e de novo, a noite inteira. Recibos de entrega,
  // presença ("digitando..."), updates de chat e sincronizações chegam MUITO
  // mais que mensagens, então isso é um batimento honesto.
  function markRecv() {
    session.lastRecv = Date.now();
    session.watchdogStrikes = 0; // ouviu de verdade: zera a escalada
  }
  for (const evt of [
    "messages.update",
    "messages.reaction",
    "message-receipt.update",
    "presence.update",
    "chats.upsert",
    "chats.update",
    "chats.delete",
    "contacts.upsert",
    "contacts.update",
    "groups.update",
    "group-participants.update",
    "messaging-history.set",
    "blocklist.set",
    "blocklist.update",
    "call",
  ]) {
    sock.ev.on(evt, markRecv);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
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
      // Zera o batimento ao conectar: dá a janela cheia do watchdog antes de
      // considerar a sessão surda (e evita reconexão em loop se seguir surda).
      session.lastRecv = Date.now();
      console.log(`[${sessionId}] ✅ conectado ao WhatsApp!`);
    }
  });

  // Auto-resposta: quando um cliente manda mensagem, responde com o link/cardápio.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    markRecv();
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

// Reconexão NÃO-destrutiva: recria o socket com a MESMA credencial, sem QR e
// sem perder conversa. É o primeiro socorro pra sessão surda (connected:true
// mas não recebe) — na maioria das vezes o socket é que morreu em silêncio, e
// isso resolve. Só se ISSO não resolver é que o caso vira /reset + QR (aí o
// problema é o pareamento). Sem essa rota, a única saída manual era o /reset,
// que apaga credencial e obriga a reescanear à toa.
app.get("/reconnect/:sessionId", (req, res) => {
  const sessionId = sanitize(req.params.sessionId);
  if (!sessionId) return res.status(400).send("Sessão inválida");
  if (!sessions.has(sessionId)) return res.status(404).send("Sessão não existe");
  softReconnect(sessionId, "reconexão manual pedida via /reconnect");
  // Zera a escalada: é uma tentativa humana, não conta como strike do watchdog.
  const session = sessions.get(sessionId);
  if (session) session.watchdogStrikes = 0;
  res.type("text/plain").send(
    `Sessão "${sessionId}" reconectando com a mesma credencial (sem QR).\n` +
      `Acompanhe em /health e /debug.`
  );
});

// Saúde das sessões: mostra há quanto tempo cada uma recebeu ALGO. É o que o
// /debug não conta — o batimento (markRecv) inclui recibos e presença, que não
// são logados. "recebeuHaMin" alto numa sessão connected = sessão surda.
app.get("/health", (req, res) => {
  const now = Date.now();
  res.json({
    watchdog: {
      janelaMin: WATCHDOG_STALE_MS / 60000,
      checaCadaMin: WATCHDOG_EVERY_MS / 60000,
      maxTentativas: WATCHDOG_MAX_STRIKES,
    },
    sessoes: [...sessions.entries()].map(([id, s]) => ({
      id,
      conectada: Boolean(s.isConnected),
      recebeuHaMin: s.lastRecv ? Math.round((now - s.lastRecv) / 60000) : null,
      tentativasWatchdog: s.watchdogStrikes || 0,
      aguardandoQR: Boolean(s.lastQR),
    })),
  });
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

// ── Watchdog: recupera sessão "surda/zumbi" sozinho, sem QR ────────────────
// O pior modo de falha do Baileys: a sessão fica connected:true, ainda ENVIA,
// mas para de RECEBER — o socket morreu em silêncio e o "close" nunca dispara,
// então nada reconecta e a loja fica horas sem o bot até alguém perceber.
//
// Detectamos pelo tempo desde o último evento RECEBIDO (session.lastRecv, ver
// markRecv). Passou do limite → derruba e reconecta com a MESMA credencial (sem
// QR, sem perder conversa). Sondas ativas (onWhatsApp) NÃO servem de teste:
// passam mesmo com a sessão surda.
//
// Duas travas contra o watchdog virar o próprio problema — porque reconectar em
// loop com a mesma credencial é justamente o caminho pro WhatsApp deslogar o
// aparelho:
//  1. Janela larga (45min). A janela antiga de 15min disparava em loja parada,
//     reconectando sessão saudável a cada 16min a noite toda.
//  2. Escalada + desistência. O lastRecv reseta ao reconectar, então sem isso a
//     sessão surda de verdade era reconectada para sempre, num ciclo fixo. Cada
//     tentativa frustrada alarga a janela; depois de MAX_STRIKES o watchdog para
//     e avisa que o caso é de /reset + QR (problema de pareamento, não de socket).
const WATCHDOG_STALE_MS = Number(process.env.WATCHDOG_STALE_MIN || 45) * 60 * 1000;
const WATCHDOG_EVERY_MS = Number(process.env.WATCHDOG_EVERY_MIN || 2) * 60 * 1000;
const WATCHDOG_MAX_STRIKES = Number(process.env.WATCHDOG_MAX_STRIKES || 3);

function softReconnect(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session) return;
  dbg(`[${sessionId}] watchdog: ${reason} — reconectando sem QR`);
  const old = session.sock;
  // Desarma o socket surdo ANTES de recriar: sem removeAllListeners, um "close"
  // atrasado dele dispararia uma segunda reconexão (socket duplicado = logout).
  session.sock = null;
  session.isConnected = false;
  session.connecting = false;
  try { old?.ev?.removeAllListeners?.(); } catch {}
  try { old?.end?.(); } catch {}
  // Conta a tentativa. Só zera quando algo REALMENTE chegar (markRecv) — o
  // "open" da reconexão não vale como prova de que a sessão voltou a ouvir.
  session.watchdogStrikes = (session.watchdogStrikes || 0) + 1;
  if (session.watchdogStrikes >= WATCHDOG_MAX_STRIKES) {
    dbg(
      `[${sessionId}] ⚠️ watchdog desistindo após ${session.watchdogStrikes} reconexões sem ` +
        `receber nada. Provável pareamento quebrado — precisa de /reset/${sessionId} e reescanear o QR.`
    );
  }
  startSession(sessionId);
}

function watchdogTick() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (!session.isConnected || !session.sock) continue; // só as "conectadas"
    const last = session.lastRecv || 0;
    if (!last) continue;
    const strikes = session.watchdogStrikes || 0;
    if (strikes >= WATCHDOG_MAX_STRIKES) continue; // já desistiu: espera /reset
    // A janela cresce a cada tentativa frustrada (45min, 90min, 135min): se
    // reconectar não resolveu, insistir no mesmo ritmo só machuca a credencial.
    if (now - last <= WATCHDOG_STALE_MS * (strikes + 1)) continue;
    softReconnect(
      sessionId,
      `sem receber nada há ${Math.round((now - last) / 60000)}min ` +
        `(tentativa ${strikes + 1}/${WATCHDOG_MAX_STRIKES})`
    );
  }
}

app.listen(PORT, () => {
  console.log(`Bot rodando na porta ${PORT}`);
  restoreSessions();
  // Recarrega as pesquisas de satisfação pendentes e reprograma os envios.
  loadSurveys();
  for (const sv of pendingSurveys) scheduleSurvey(sv);
  // Liga o watchdog de sessão surda.
  setInterval(watchdogTick, WATCHDOG_EVERY_MS);
  // Via dbg (não console.log) pra config efetiva aparecer no /debug: se houver
  // uma variável antiga no Railway sobrescrevendo o padrão, dá pra ver daqui.
  dbg(
    `Watchdog ativo: checa a cada ${WATCHDOG_EVERY_MS / 60000}min; ` +
      `reconecta sessão sem receber há +${WATCHDOG_STALE_MS / 60000}min; ` +
      `desiste após ${WATCHDOG_MAX_STRIKES} tentativas.`
  );
});
