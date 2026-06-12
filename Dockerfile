# ============================================================
#  Single Render service: Node WhatsApp bot + Python VRF engine
#  co-hosted in one container.
#
#  - The bot (server.js) listens on Render's public $PORT and
#    receives the WhatsApp webhook.
#  - The VRF engine (vrf-sidecar, FastAPI) listens on 127.0.0.1:8000,
#    internal only. The bot reaches it via VRF_SIDECAR_URL.
#
#  This removes the separate free-tier sidecar service that slept and
#  cold-started (502s). The Python engine is UNCHANGED — only co-hosted.
# ============================================================
FROM node:24-slim

# Python runtime for the VRF sidecar.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps (own layer so it caches unless package*.json changes).
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps for the VRF engine (own layer; cached unless requirements change).
COPY vrf-sidecar/requirements.txt ./vrf-sidecar/
RUN pip3 install --no-cache-dir --break-system-packages -r vrf-sidecar/requirements.txt

# App source.
COPY . .

# Start the VRF engine on localhost (background), then the bot on $PORT.
# `exec node` makes the bot PID 1 so the container stops if the bot stops.
CMD ["sh", "-c", "python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 --app-dir vrf-sidecar & exec node server.js"]
