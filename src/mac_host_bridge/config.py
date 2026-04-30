from enum import Enum
import os

class ApprovedService(str, Enum):
    nanoclaw = "nanoclaw"
    mcp_bridge = "mcp-bridge"
    ollama = "ollama"

APPROVED_LOG_PATHS: dict[str, str] = {
    "nanoclaw": os.path.expanduser("~/nanoclaw/logs/nanoclaw.log"),
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
        "nanoclaw_logs":        "tail -100 /Users/lucascarroll/nanoclaw/logs/nanoclaw.log",
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
