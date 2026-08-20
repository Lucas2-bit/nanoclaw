#!/bin/bash
# Deploy the tracked mac-host-bridge source to the live LaunchDaemon.
#
# Source of truth : ~/nanoclaw/mac-host-bridge/src/mac_host_bridge  (git-tracked)
# Deploy target   : /opt/mcp-bridge/src/mac_host_bridge             (read by the
#                   daemon via PYTHONPATH set in
#                   /Library/LaunchDaemons/com.mcp-bridge.plist)
#
# Why this script exists: the mirror step used to be a comment in config.py that
# had to be retyped by hand. It drifted, and three diverging copies of the
# source appeared. Two of the bugs that took Ulterior down for hours
# (gui-vs-system launchd domain, wrong ollama label) were fixed in one copy and
# not the others. One scripted path removes that failure mode.
#
# The daemon runs as root in the system launchd domain, so the restart needs
# sudo. Everything before it is validated first, so a syntax error cannot take
# a working bridge down.
set -euo pipefail

REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src/mac_host_bridge"
LIVE_SRC="/opt/mcp-bridge/src/mac_host_bridge"
VENV_PY="/opt/mcp-bridge/.venv/bin/python3.12"
LABEL="system/com.mcp-bridge"
PORT=9222

echo "==> Validating source before touching the live daemon"
"$VENV_PY" -m compileall -q "$REPO_SRC" \
  || { echo "FAIL: source does not compile — aborting, live daemon untouched"; exit 1; }

PYTHONPATH="$(dirname "$REPO_SRC")" "$VENV_PY" -c "
import importlib
for m in ('mac_host_bridge.config','mac_host_bridge.tools.services',
          'mac_host_bridge.tools.health','mac_host_bridge.audit',
          'mac_host_bridge.server'):
    importlib.import_module(m)
from mac_host_bridge.server import mcp
" || { echo "FAIL: import/app construction failed — aborting, live daemon untouched"; exit 1; }
echo "    compiles and imports cleanly"

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "==> Backing up live tree to ${LIVE_SRC}.bak-${STAMP}"
sudo cp -R "$LIVE_SRC" "${LIVE_SRC}.bak-${STAMP}"

echo "==> Mirroring repo -> live"
sudo rsync -a --delete \
  --exclude '__pycache__' --exclude '*.pyc' --exclude '*.bak-*' \
  "$REPO_SRC/" "$LIVE_SRC/"

echo "==> Restarting daemon ($LABEL)"
sudo launchctl kickstart -k "$LABEL"

echo "==> Waiting for the bridge to answer on :$PORT"
for _ in $(seq 1 30); do
  if curl -sf --max-time 3 -X POST "http://127.0.0.1:$PORT/mcp" \
       -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy","version":"1"}}}' \
       2>/dev/null | grep -q serverInfo; then
    echo "    bridge is up and answering MCP"
    echo
    echo "Deployed. Roll back with:"
    echo "  sudo rsync -a --delete ${LIVE_SRC}.bak-${STAMP}/ $LIVE_SRC/ && sudo launchctl kickstart -k $LABEL"
    exit 0
  fi
  sleep 1
done

echo "FAIL: bridge did not answer within 30s. Roll back with:"
echo "  sudo rsync -a --delete ${LIVE_SRC}.bak-${STAMP}/ $LIVE_SRC/ && sudo launchctl kickstart -k $LABEL"
exit 1
