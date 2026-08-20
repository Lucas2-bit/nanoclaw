import os
import signal as signal_module
import psutil
from typing import Literal

SIGNAL_MAP: dict[str, signal_module.Signals] = {
    "SIGTERM": signal_module.SIGTERM,
    "SIGKILL": signal_module.SIGKILL,
}

BRIDGE_PID = os.getpid()


def get_port_info(port: int, protocol: str = "tcp") -> dict:
    if not (1 <= port <= 65535):
        return {"error": "port must be between 1 and 65535"}
    if protocol not in ("tcp", "udp"):
        return {"error": "protocol must be 'tcp' or 'udp'"}

    try:
        connections = psutil.net_connections(kind=protocol)
    except psutil.AccessDenied:
        return {"error": "access denied — bridge may need elevated permissions"}

    for conn in connections:
        if conn.laddr and conn.laddr.port == port and conn.pid:
            try:
                proc = psutil.Process(conn.pid)
                with proc.oneshot():
                    return {
                        "port": port,
                        "protocol": protocol,
                        "status": "in_use",
                        "pid": conn.pid,
                        "process_name": proc.name(),
                        "user": proc.username(),
                        "command_line": " ".join(proc.cmdline()),
                        "connection_status": conn.status if hasattr(conn, "status") else None,
                    }
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return {
                    "port": port,
                    "protocol": protocol,
                    "status": "in_use",
                    "pid": conn.pid,
                    "process_name": "unknown",
                    "user": "unknown",
                    "command_line": "unknown",
                }

    return {"port": port, "protocol": protocol, "status": "free"}


def kill_process_on_port(
    port: int,
    signal: str,
    confirm: bool,
    protocol: str = "tcp",
) -> dict:
    if not (1 <= port <= 65535):
        return {"error": "port must be between 1 and 65535"}
    if protocol not in ("tcp", "udp"):
        return {"error": "protocol must be 'tcp' or 'udp'"}
    if signal.upper() not in SIGNAL_MAP:
        return {"error": f"signal must be one of: {list(SIGNAL_MAP.keys())}"}

    # Resolve port info first
    port_info = get_port_info(port, protocol)
    if port_info.get("status") == "free":
        return {"action": "no_op", "message": f"No process found on {protocol} port {port}"}
    if "error" in port_info:
        return port_info

    pid = port_info["pid"]
    process_name = port_info.get("process_name", "unknown")

    if not confirm:
        return {
            "action": "dry_run",
            "description": f"Would send {signal} to PID {pid} ({process_name}) holding {protocol} port {port}",
            "pid": pid,
            "process_name": process_name,
            "port": port,
            "signal": signal,
            "to_execute": "set confirm=true to proceed",
        }

    if pid == 1:
        return {"error": "refusing to kill PID 1 (system init process)"}
    if pid == BRIDGE_PID:
        return {"error": "refusing to kill the bridge's own process"}

    sig = SIGNAL_MAP[signal.upper()]
    try:
        proc = psutil.Process(pid)
        proc.send_signal(sig)
        return {
            "action": "killed",
            "pid": pid,
            "process_name": process_name,
            "port": port,
            "protocol": protocol,
            "signal_sent": signal,
        }
    except psutil.NoSuchProcess:
        return {"action": "no_op", "message": f"PID {pid} no longer exists"}
    except psutil.AccessDenied:
        return {"error": f"access denied — cannot send {signal} to PID {pid} ({process_name})"}
