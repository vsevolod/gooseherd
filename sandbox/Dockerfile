# Gooseherd Sandbox — isolated container for agent runs
#
# Contains all tools needed by pipeline nodes:
#   git, pi-agent CLI, node, curl, gitleaks, chromium (for screenshots)
#
# Usage:
#   docker build -t gooseherd/sandbox:default sandbox/
#   docker run --rm gooseherd/sandbox:default pi --version

FROM node:22-bookworm-slim

# System tools needed by pipeline nodes
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    chromium \
    procps \
    findutils \
    sed \
    coreutils \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# ── AI Agent CLIs ──
# pi-agent (default)
RUN npm install -g @mariozechner/pi-coding-agent \
  && pi --version

# OpenAI Codex CLI (needs CODEX_API_KEY at runtime)
RUN npm install -g @openai/codex \
  && codex --version || true

# Claude Code CLI (needs ANTHROPIC_API_KEY at runtime)
RUN npm install -g @anthropic-ai/claude-code \
  && claude --version || true

# Cursor Agent CLI (needs CURSOR_API_KEY at runtime)
RUN curl -fsSL https://cursor.com/install | bash \
  && export PATH="$HOME/.local/bin:$PATH" \
  && cursor-agent --version || true
ENV PATH="/root/.local/bin:$PATH"

# Gitleaks (secret scanner)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GOOS_ARCH="x64"; else GOOS_ARCH="$ARCH"; fi && \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_${GOOS_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin gitleaks \
  && gitleaks version || true

# All browser tools use system chromium — skip bundled browser downloads
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@latest pa11y@latest @browserbasehq/stagehand@latest deepmerge@latest \
  && npx playwright install ffmpeg

# Pa11y config — run Chromium with --no-sandbox (required when running as root)
RUN printf '{"chromeLaunchConfig":{"executablePath":"/usr/bin/chromium","args":["--no-sandbox","--disable-setuid-sandbox"]}}\n' > /etc/pa11y.json

# CEMS MCP (memory tools — kept for future pi-agent extension support)
# Install uv (Python package manager), then install cems package which provides cems-mcp binary
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && export PATH="$HOME/.local/bin:$PATH" \
  && uv tool install "cems @ git+https://github.com/chocksy/cems.git" --force \
  && ln -sf $HOME/.local/bin/cems-mcp /usr/local/bin/cems-mcp \
  && cems-mcp --help || true
# uv installs to /root/.local/bin during build; cems-mcp is symlinked to /usr/local/bin
# Keep path for any uv-managed tools still referenced from root install
ENV PATH="/root/.local/bin:$PATH"

# Copy sandbox-compatible dummy agent for E2E testing
COPY sandbox-dummy-agent.sh /usr/local/bin/sandbox-dummy-agent.sh
RUN chmod +x /usr/local/bin/sandbox-dummy-agent.sh

# Run as non-root user for security
RUN useradd -m -s /bin/bash gooseherd \
  && mkdir -p /work \
  && chown gooseherd:gooseherd /work
USER gooseherd

WORKDIR /work

# OCI labels — links GHCR package to repo (shows README on package page)
LABEL org.opencontainers.image.source="https://github.com/chocksy/gooseherd"
LABEL org.opencontainers.image.description="Sandbox container for Gooseherd — isolated environment for AI agent runs"
LABEL org.opencontainers.image.licenses="MIT"

# Keep container alive for exec commands
CMD ["sleep", "infinity"]
