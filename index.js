const express = require("express");
const QRCode = require("qrcode");
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
// Pasta da sessão. Na Railway, aponte para um Volume persistente (ex: /data/auth)
// definindo AUTH_DIR — senão o QR precisa ser escaneado a cada restart.
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
// Token de segurança: se definido, o /send exige Authorization: Bearer <token>.
const BOT_TOKEN = process.env.BOT_TOKEN || "";

let sock = null;
let isConnected = false;
let lastQR = null; // último QR Code (para mostrar na página web)

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      // Mostra também no terminal (alguns visualizadores de log renderizam).
      try {
        console.log(await QRCode.toString(qr, { type: "terminal", small: true }));
      } catch {}
      console.log("\n=== Abra a URL do bot no navegador para escanear o QR Code ===\n");
    }

    if (connection === "close") {
      isConnected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("Conexão caiu, reconectando...");
        connectWhatsApp();
      } else {
        console.log("Sessão encerrada. Apague a pasta de auth e reinicie para reconectar.");
      }
    }

    if (connection === "open") {
      isConnected = true;
      lastQR = null;
      console.log("✅ Bot conectado ao WhatsApp com sucesso!");
    }
  });
}

// Normaliza telefone brasileiro para o JID do WhatsApp.
// Aceita "11999998888" (11 díg) ou "5511999998888" (já com país) e devolve
// o JID real consultando o WhatsApp — isso resolve a variação do 9º dígito.
async function resolveJid(phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  // Adiciona o código do Brasil (55) quando vier só com DDD + número.
  if (digits.length <= 11) digits = "55" + digits;
  const results = await sock.onWhatsApp(digits);
  const hit = results?.[0];
  if (!hit?.exists) return null;
  return hit.jid;
}

// Rota que o sistema chama para enviar mensagem.
app.post("/send", async (req, res) => {
  if (BOT_TOKEN) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== BOT_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone e message são obrigatórios" });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ error: "Bot não conectado ao WhatsApp" });
  }

  try {
    const jid = await resolveJid(phone);
    if (!jid) {
      console.log(`Número sem WhatsApp ou inválido: ${phone}`);
      return res.status(404).json({ error: "Número não encontrado no WhatsApp" });
    }
    await sock.sendMessage(jid, { text: message });
    console.log(`Mensagem enviada para ${jid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Status do bot (JSON) — útil para monitoramento.
app.get("/status", (req, res) => {
  res.json({ connected: isConnected });
});

// Página inicial: mostra o QR Code para conectar, ou avisa que já está conectado.
app.get("/", async (req, res) => {
  if (isConnected) {
    return res.send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>✅ Bot conectado ao WhatsApp</h2>
       <p>Tudo certo! As mensagens automáticas estão funcionando.</p>
       </body></html>`
    );
  }
  if (!lastQR) {
    return res.send(
      `<html><head><meta http-equiv="refresh" content="3"></head>
       <body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>Gerando QR Code...</h2>
       <p>Aguarde alguns segundos. A página atualiza sozinha.</p>
       </body></html>`
    );
  }
  try {
    const dataUrl = await QRCode.toDataURL(lastQR, { width: 300 });
    res.send(
      `<html><head><meta http-equiv="refresh" content="20"></head>
       <body style="font-family:sans-serif;text-align:center;padding:40px">
       <h2>Escaneie com o WhatsApp</h2>
       <p>WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
       <img src="${dataUrl}" alt="QR Code" />
       <p style="color:#888">A página atualiza sozinha quando conectar.</p>
       </body></html>`
    );
  } catch (err) {
    res.status(500).send("Erro ao gerar QR Code");
  }
});

app.listen(PORT, () => {
  console.log(`Bot rodando na porta ${PORT}`);
  connectWhatsApp();
});
