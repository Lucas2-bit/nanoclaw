import time
from mac_host_bridge.config import (
    APPROVED_LOG_PATHS,
    FALLBACK_LOG_DIR,
    LOG_DIR,
    VERSION,
    ApprovedService,
)
import os

START_TIME = time.time()
CALL_COUNTER: int = 0


def get_bridge_health() -> dict:
    log_dir = LOG_DIR if os.path.exists(LOG_DIR) else FALLBACK_LOG_DIR

    # Report whether each approved log path actually resolves to a file.
    # A misconfigured path makes get_logs return nothing, which is
    # indistinguishable from "the service is dead" — that ambiguity caused a
    # 9h silent outage (2026-05-31, nanoclaw) and later made a healthy ollama
    # look down. Surfacing it here turns a silent misconfiguration into a
    # visible one.
    log_paths = {
        name: {"path": path, "exists": os.path.isfile(path)}
        for name, path in APPROVED_LOG_PATHS.items()
    }
    missing = sorted(n for n, v in log_paths.items() if not v["exists"])

    return {
        "status": "ok" if not missing else "degraded",
        "version": VERSION,
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "calls_total": CALL_COUNTER,
        "approved_services": [s.value for s in ApprovedService],
        "log_dir": log_dir,
        "log_paths": log_paths,
        # Non-empty means get_logs will come back empty for these services.
        # It does NOT mean the services themselves are down.
        "log_paths_missing": missing,
        "port": int(os.environ.get("MCP_BRIDGE_PORT", "9222")),
    }
