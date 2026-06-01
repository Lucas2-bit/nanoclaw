from enum import Enum
import os

class ApprovedService(str, Enum):
    nanoclaw = "nanoclaw"
    mcp_bridge = "mcp-bridge"
    ollama = "ollama"

# Live sink for nanoclaw stdout is pm2's per-process out-log, NOT
# ~/nanoclaw/logs/nanoclaw.log (the old file-based log that the app no
# longer writes — get_logs against it returned empty for the entire
# 9h silent outage on 2026-05-31). Resolved from $NANOCLAW_PM2_OUT_LOG
# or $PM2_HOME at import time; default matches the standard PM2 layout.
NANOCLAW_PM2_OUT_LOG: str = (
    os.environ.get("NANOCLAW_PM2_OUT_LOG")
    or os.path.join(
        os.environ.get("PM2_HOME") or os.path.expanduser("~/.pm2"),
        "logs",
        "nanoclaw-out.log",
    )
)

APPROVED_LOG_PATHS: dict[str, str] = {
    "nanoclaw": NANOCLAW_PM2_OUT_LOG,
    "mcp-bridge": "/var/log/mcp-bridge/server.log",
    "ollama": os.path.expanduser("~/.ollama/logs/server.log"),
}

LAUNCHD_LABELS: dict[str, str] = {
    "nanoclaw": "com.nanoclaw",
    "mcp-bridge": "com.mcp-bridge",
    "ollama": "com.ollama",
}

LUCAS_UID: str = ""
LOG_DIR = "/var/log/mcp-bridge"
FALLBACK_LOG_DIR = os.path.expanduser("~/nanoclaw/logs")
VERSION = "1.0.0"

import os as _os

class ApprovedCommand(str, Enum):
    NANOCLAW_BUILD   = "nanoclaw_build"
    NANOCLAW_RESTART = "nanoclaw_restart"
    NANOCLAW_STOP    = "nanoclaw_stop"
    NANOCLAW_LOGS    = "nanoclaw_logs"
    NPM_INSTALL      = "nanoclaw_npm_install"

def _approved_commands() -> dict[str, str]:
    uid = LUCAS_UID or "501"
    npm = "/opt/homebrew/bin/npm"
    pm2 = "/opt/homebrew/bin/pm2"
    return {
        "nanoclaw_build":       f"cd /Users/lucascarroll/nanoclaw && {npm} run build 2>&1",
        "nanoclaw_restart":     f"{pm2} restart nanoclaw 2>&1",
        "nanoclaw_stop":        f"{pm2} stop nanoclaw 2>&1",
        "nanoclaw_logs":        f"tail -100 {NANOCLAW_PM2_OUT_LOG}",
        "nanoclaw_npm_install": f"cd /Users/lucascarroll/nanoclaw && {npm} install 2>&1",
    }

NO_ARGS_COMMANDS = {"nanoclaw_restart", "nanoclaw_stop"}

APPROVED_WRITE_PREFIXES = [
    "/Users/lucascarroll/nanoclaw/src",
    "/Users/lucascarroll/nanoclaw/config",
    "/Users/lucascarroll/nanoclaw/groups",
]
BACKUP_DIR            = "/Users/lucascarroll/nanoclaw/.bridge-backups/"
MAX_WRITE_SIZE_BYTES  = 512 * 1024  # 500 KB
