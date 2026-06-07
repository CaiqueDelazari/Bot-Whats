const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

// Uma sessão por cliente/número. sessionId -> { sock, isConnected, lastQR }
const sessions = new Map();

// Mantém só letras, números, hífen e underscore — evita path traversal.
function sanitize(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

async function startSession(sessionId) {
  let session = sessions.get(sessionId);
  if (session?.sock) return session; // já está rodando
  if (!session) {
    session = { sock: null, isConnected: false, lastQR: null };
    sessions.set(sessionId, session);
  }

  const authPath = path.join(AUTH_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
  });
  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.lastQR = qr;
      console.log(`[${sessionId}] QR Code gerado — abra /connect/${sessionId} para escanear`);
    }

    if (connection === "close") {
      session.isConnected = false;
      session.sock = null;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`[${sessionId}] conexão caiu, reconectando...`);
        startSession(sessionId);
      } else {
        console.log(`[${sessionId}] sessão encerrada (logout). Reescaneie para reconectar.`);
        sessions.delete(sessionId);
      }
    }

    if (connection === "open") {
      session.isConnected = true;
      session.lastQR = null;
      console.log(`[${sessionId}] ✅ conectado ao WhatsApp!`);
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

// Envio de mensagem. Body: { session, phone, message }
app.post("/send", async (req, res) => {
  if (BOT_TOKEN) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== BOT_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }
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
