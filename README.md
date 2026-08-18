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
| `BOT_TOKEN` | **Sim** | Protege **todas** as rotas. Deve ser igual ao `WHATSAPP_BOT_TOKEN` das cópias do sistema. Sem ele o bot sobe trancado com um token aleatório e as lojas não conseguem enviar nada |

## Rodando localmente

```bash
npm install
npm start
```

Conectar um cliente: abra `http://localhost:3001/connect/ID-DO-CLIENTE` e escaneie.

## Endpoints

**Nenhuma rota é pública.** Toda requisição precisa do `BOT_TOKEN`, no header
`Authorization: Bearer <token>` (é como as lojas chamam) ou como `?token=<token>`
na URL — as telas de operação são abertas no navegador, onde não dá pra mandar
header. Ex: `/health?token=SEU_BOT_TOKEN`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Lista todas as sessões e o status de cada uma |
| GET | `/connect/:sessionId` | Página com o QR Code para conectar aquela sessão |
| GET | `/status/:sessionId` | `{ session, connected }` |
| POST | `/send` | Envia mensagem. Body: `{ session, phone, message }` |
| GET | `/config/:sessionId` | Lê a config de auto-resposta da sessão |
| POST | `/config/:sessionId` | Define a auto-resposta. Body: `{ autoReplyEnabled, autoReplyMessage }` |

## Auto-resposta (responder "oi" com o link)

Quando um cliente manda mensagem para o número conectado, o bot pode responder
automaticamente com uma mensagem fixa (ex: o link do cardápio).

Ative por sessão:

```bash
curl -X POST https://SEU-BOT/config/ID-DO-CLIENTE \
  -H "Authorization: Bearer SEU_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"autoReplyEnabled":true,"autoReplyMessage":"Olá! Faça seu pedido: https://site/cardapio"}'
```

- A config fica salva em disco (no Volume), uma por sessão.
- Para não responder toda mensagem da mesma conversa, há um intervalo mínimo entre
  respostas ao mesmo contato: `AUTOREPLY_COOLDOWN_MIN` (minutos, padrão `360` = 6h;
  use `0` para responder sempre).
- O bot ignora mensagens próprias, grupos e status.

## Deploy na Railway

Veja o passo a passo completo em `CONFIGURAR_WHATSAPP.md` (pasta do projeto principal).
Resumo: deploy do repositório → Volume em `/data` → variáveis `AUTH_DIR=/data/auth`
e `BOT_TOKEN` → Generate Domain → conectar cada cliente em `/connect/<id>`.
