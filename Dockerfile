# ── build stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── runtime stage ────────────────────────────────────────────
FROM node:22-bookworm-slim

# System deps:
#   git            – pipeline git operations (clone, push, etc.)
#   curl           – health checks, API calls
#   ca-certificates – HTTPS for git + API calls
#   chromium       – headless browser for Stagehand (runs in main process)
#   ffmpeg         – encode CDP screencast frames → mp4
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    chromium \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Stagehand launches Chromium in main process — use system package, skip bundled download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install pi-agent (AI coding agent)
RUN npm install -g @mariozechner/pi-coding-agent \
  && pi --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY scripts/ scripts/
COPY pipelines/ pipelines/
COPY extensions/ extensions/

# Run as non-root user for security
RUN useradd -m -s /bin/bash gooseherd \
  && mkdir -p .work data \
  && chown -R gooseherd:gooseherd .work data
USER gooseherd

# Dashboard must bind to all interfaces inside a container
ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "dist/index.js"]
