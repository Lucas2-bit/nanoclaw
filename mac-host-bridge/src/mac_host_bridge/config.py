from enum import Enum
import os

class ApprovedService(str, Enum):
    nanoclaw = "nanoclaw"
    mcp_bridge = "mcp-bridge"
    ollama = "ollama"

# This process runs as root (it is a LaunchDaemon with no UserName key), so
# os.path.expanduser("~") resolves to /var/root — NOT Lucas's home directory.
# Any user-scoped path must be anchored to this constant instead. Using "~"
# here silently produced paths that do not exist, which is indistinguishable
# from "the service is broken" in tool output — see the ollama note below.
# Overridable via env so this is not hardcoded for a single machine.
LUCAS_HOME: str = os.environ.get("MCP_BRIDGE_USER_HOME") or "/Users/lucascarroll"

# Live sink for nanoclaw stdout is pm2's per-process out-log, NOT
# ~/nanoclaw/logs/nanoclaw.log (the old file-based log that the app no
# longer writes — get_logs against it returned empty for the entire
# 9h silent outage on 2026-05-31). Resolved from $NANOCLAW_PM2_OUT_LOG
# or $PM2_HOME at import time; default matches the standard PM2 layout.
NANOCLAW_PM2_OUT_LOG: str = (
    os.environ.get("NANOCLAW_PM2_OUT_LOG")
    or os.path.join(
        os.environ.get("PM2_HOME") or os.path.join(LUCAS_HOME, ".pm2"),
        "logs",
        "nanoclaw-out.log",
    )
)

APPROVED_LOG_PATHS: dict[str, str] = {
    "nanoclaw": NANOCLAW_PM2_OUT_LOG,
    "mcp-bridge": "/var/log/mcp-bridge/server.log",
    # Homebrew's ollama service logs here per its own plist
    # (homebrew.mxcl.ollama -> StandardOut/ErrorPath). The previous value,
    # expanduser("~/.ollama/logs/server.log"), resolved to
    # /var/root/.ollama/... under root and does not exist under Lucas's home
    # either, so get_logs("ollama") could never return anything — which read
    # as "ollama is broken" rather than "the path is wrong".
    "ollama": "/opt/homebrew/var/log/ollama.log",
}

LAUNCHD_LABELS: dict[str, str] = {
    "nanoclaw": "com.nanoclaw",
    # System LaunchDaemon (/Library/LaunchDaemons) -> resolved in the "system"
    # launchd domain, not gui/<uid>. See tools/services._candidate_domains.
    "mcp-bridge": "com.mcp-bridge",
    # Installed by Homebrew, whose label is homebrew.mxcl.<formula>. The old
    # value "com.ollama" matches no job on this host, so status lookups always
    # returned "not_loaded" for a service that was running fine.
    "ollama": "homebrew.mxcl.ollama",
}

LUCAS_UID: str = ""
LOG_DIR = "/var/log/mcp-bridge"
FALLBACK_LOG_DIR = os.path.join(LUCAS_HOME, "nanoclaw", "logs")  # not "~": runs as root
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
