import collections
import os
import mac_host_bridge.config as config


def get_logs(service_name: config.ApprovedService, lines: int = 50) -> dict:
    if lines < 1:
        lines = 1
    if lines > 500:
        lines = 500

    log_path = config.APPROVED_LOG_PATHS.get(service_name.value)
    if not log_path:
        return {"error": f"No log path configured for service: {service_name.value}"}

    log_path = os.path.expanduser(log_path)

    if not os.path.exists(log_path):
        return {
            "service": service_name.value,
            "log_path": log_path,
            "lines": [],
            "message": "Log file does not exist yet",
        }

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            tail = list(collections.deque(f, maxlen=lines))
        return {
            "service": service_name.value,
            "log_path": log_path,
            "lines_returned": len(tail),
            "lines": [line.rstrip("\n") for line in tail],
        }
    except PermissionError:
        return {"error": f"Permission denied reading log at {log_path}"}
    except OSError as e:
        return {"error": f"Could not read log: {e}"}
