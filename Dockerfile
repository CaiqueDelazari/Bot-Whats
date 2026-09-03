# Imagem do bot, para rodar ao lado de outro sistema em vez de num PaaS.
#
# A sessao do WhatsApp e um pareamento de aparelho: perder a pasta de auth
# significa reescanear o QR de cada numero. Por isso AUTH_DIR aponta para um
# volume, e nao para dentro da imagem.
FROM node:20-alpine

WORKDIR /app

# As dependencias primeiro: assim uma mudanca no index.js nao refaz o npm ci.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3001 \
    AUTH_DIR=/data/auth

EXPOSE 3001

# /health e a unica rota antes do portao de token — de proposito, para que o
# healthcheck nao precise carregar segredo nenhum.
#
# A porta vem do ambiente, nao fixa: o index.js escuta em `process.env.PORT`, e
# uma PaaS injeta a dela (a Railway injeta). Com 3001 cravado aqui, o app subia
# na porta da plataforma, o healthcheck batia na 3001, dava ruim, e o container
# entrava em ciclo de restart — derrubando a sessao de WhatsApp de todas as
# lojas a cada reinicio.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" || exit 1

CMD ["node", "index.js"]
