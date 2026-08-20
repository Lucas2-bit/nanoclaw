# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and PDF tools
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
#
# The Gmail and Calendar MCP servers are installed here too, rather than being
# fetched with `npx -y ...` at container start. Containers run with --rm and no
# persistent npm cache, so npx re-downloaded these packages (plus dependencies)
# on EVERY spawn — measured at >40s, which is far longer than the MCP client
# waits for a stdio server to complete its handshake. The result was Gmail and
# Calendar tools intermittently failing to connect with no useful error.
# Baking them in makes startup instant and offline-safe. Versions are pinned so
# a registry change can't silently alter behaviour mid-deploy.
RUN npm install -g \
    agent-browser \
    @anthropic-ai/claude-code \
    @gongrzhe/server-gmail-autoauth-mcp@1.1.11 \
    @gongrzhe/server-calendar-autoauth-mcp@1.0.2

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Install pdf-reader CLI
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Chromium's crash handler (crashpad) calls getpwuid() during init and
# HARD-TRAPS (SIGTRAP) if the current UID has no /etc/passwd entry — bypasses
# every sandbox/zygote/single-process flag. This container is run with
# --user ${hostUid}:${hostGid} on macOS (container-runner.ts sets it whenever
# host uid != 0 && != 1000) so bind-mount files match the host user's
# permissions. The base image only ships passwd entries for `root` and
# `node` (uid 1000) — an unlisted host UID (typically 501 on macOS) leaves
# getpwuid empty and Chromium traps.
#
# Fix: add a passwd entry for uid 501 at build time. Hard-coded for Lucas's
# personal system; if this container is ever run on a host with a different
# UID, add another entry below OR generalize via an entrypoint.sh check that
# appends missing entries with write access preserved.
RUN echo "runner:x:501:20:macOS host user:/tmp:/bin/bash" >> /etc/passwd

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
