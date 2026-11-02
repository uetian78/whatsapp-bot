# ============================================================
#  Single Railway service: the Node HVAC Assistant (web app, and the
#  WhatsApp webhook when enabled). It listens on Railway's public $PORT.
#  Data (databases) lives on the Railway volume: mount it and set
#  DATA_DIR to its mount path (see .env.example).
# ============================================================
FROM node:24-slim

# Express prints stack traces and file paths on errors unless this is
# "production". (server.js also never returns one, whatever this is.)
ENV NODE_ENV=production

WORKDIR /app

# Node deps (own layer so it caches unless package*.json changes).
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

CMD ["node", "server.js"]
