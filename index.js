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
    session = { sock: null, isConnected: false, lastQR: null, connecting: false, retries: 0 };
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
      console.log(`[${sessionId}] ✅ conectado ao WhatsApp!`);
    }
  });

  // Auto-resposta: quando um cliente manda mensagem, responde com o link/cardápio.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
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

// Debug: últimas linhas de log em memória (pra diagnosticar à distância).
app.get("/debug", (req, res) => {
  res.type("text/plain").send(debugLog.join("\n") || "(sem eventos ainda)");
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
});
