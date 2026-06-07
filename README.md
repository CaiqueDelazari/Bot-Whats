# Bot WhatsApp — Espetaria Brasa

Bot que envia notificações automáticas no WhatsApp do cliente quando o pedido
muda de status (recebido, em preparo, saiu para entrega, etc.).

## Como funciona

O sistema (na Vercel) faz uma chamada `POST /send` para este bot, que envia a
mensagem pelo WhatsApp conectado via QR Code.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não | Porta do servidor (a Railway define sozinha) |
| `AUTH_DIR` | **Sim (na Railway)** | Pasta da sessão. Use `/data/auth` com um Volume montado em `/data` para não perder a conexão a cada restart |
| `BOT_TOKEN` | Recomendado | Senha que protege o endpoint `/send`. Deve ser igual ao `WHATSAPP_BOT_TOKEN` configurado na Vercel |

## Rodando localmente (teste)

```bash
npm install
npm start
```

Depois abra `http://localhost:3001` no navegador e escaneie o QR Code.

## Deploy na Railway

1. Suba esta pasta para um repositório no GitHub
2. Na Railway: New Project → Deploy from GitHub repo
3. Adicione um **Volume** com mount path `/data`
4. Em Variables, defina:
   - `AUTH_DIR=/data/auth`
   - `BOT_TOKEN=` (uma senha aleatória longa)
5. Em Settings → Networking → Generate Domain
6. Abra o domínio gerado no navegador e escaneie o QR Code

> O guia completo passo a passo está em `CONFIGURAR_WHATSAPP.md` (na pasta do projeto principal).

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Página com o QR Code para conectar |
| GET | `/status` | Retorna `{ connected: true/false }` |
| POST | `/send` | Envia mensagem. Body: `{ phone, message }`. Header: `Authorization: Bearer <BOT_TOKEN>` |
