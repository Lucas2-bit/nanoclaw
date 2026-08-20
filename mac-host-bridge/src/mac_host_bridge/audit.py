from __future__ import annotations
import json
import logging
import logging.handlers
import os
import time
from pathlib import Path

import mac_host_bridge.config as config

_audit_logger: logging.Logger | None = None


def _get_logger() -> logging.Logger:
    global _audit_logger
    if _audit_logger is not None:
        return _audit_logger

    log_dir = Path(config.LOG_DIR)
    if not log_dir.exists():
        log_dir = Path(config.FALLBACK_LOG_DIR)
        log_dir.mkdir(parents=True, exist_ok=True)

    handler = logging.handlers.RotatingFileHandler(
        log_dir / "audit.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))

    logger = logging.getLogger("mcp_bridge.audit")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    _audit_logger = logger
    return logger


def write_audit_entry(
    tool_name: str,
    inputs: dict,
    result: dict | list | str,
    duration_ms: float,
) -> None:
    def _summarise(r: dict | list | str) -> str:
        if isinstance(r, dict):
            if "error" in r:
                return f"error: {r['error']}"
            if r.get("action") == "dry_run":
                return "dry_run"
            return "ok"
        return "ok"

    # Redact log line content from get_logs results
    safe_result = result
    if isinstance(result, dict) and "lines" in result:
        safe_result = {**result, "lines": f"<{len(result.get('lines', []))} lines redacted>"}

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool": tool_name,
        "inputs": inputs,
        "result_summary": _summarise(result),
        "duration_ms": round(duration_ms, 1),
    }
    _get_logger().info(json.dumps(entry))
