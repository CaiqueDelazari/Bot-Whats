# Bot WhatsApp — multi-cliente

Bot que envia notificações automáticas no WhatsApp quando um pedido muda de
status. É **compartilhado**: um único bot atende vários clientes, cada um com a
própria conexão de WhatsApp (uma "sessão"), identificada por um `session` id.

## Como funciona

Cada cópia do sistema (na Vercel) chama `POST /send` com o seu `session` id.
O bot mantém uma conexão de WhatsApp separada por sessão.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não | Porta (a Railway define sozinha) |
| `AUTH_DIR` | **Sim na Railway** | Pasta das sessões. Use `/data/auth` com um Volume em `/data` para não perder as conexões a cada restart |
| `BOT_TOKEN` | Recomendado | Protege o `/send`. Deve ser igual ao `WHATSAPP_BOT_TOKEN` das cópias do sistema |

## Rodando localmente

```bash
npm install
npm start
```

Conectar um cliente: abra `http://localhost:3001/connect/ID-DO-CLIENTE` e escaneie.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Lista todas as sessões e o status de cada uma |
| GET | `/connect/:sessionId` | Página com o QR Code para conectar aquela sessão |
| GET | `/status/:sessionId` | `{ session, connected }` |
| POST | `/send` | Envia mensagem. Body: `{ session, phone, message }`. Header: `Authorization: Bearer <BOT_TOKEN>` |

## Deploy na Railway

Veja o passo a passo completo em `CONFIGURAR_WHATSAPP.md` (pasta do projeto principal).
Resumo: deploy do repositório → Volume em `/data` → variáveis `AUTH_DIR=/data/auth`
e `BOT_TOKEN` → Generate Domain → conectar cada cliente em `/connect/<id>`.
