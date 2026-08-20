import os
import subprocess
import time
from typing import Annotated, Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

import mac_host_bridge.config as config
import mac_host_bridge.tools.health as health_module
from mac_host_bridge.audit import write_audit_entry
from mac_host_bridge.tools.ports import get_port_info as _get_port_info
from mac_host_bridge.tools.ports import kill_process_on_port as _kill_process_on_port
from mac_host_bridge.tools.processes import list_processes as _list_processes
from mac_host_bridge.tools.resources import get_system_resources as _get_system_resources
from mac_host_bridge.tools.services import get_service_status as _get_service_status
from mac_host_bridge.tools.services import restart_service as _restart_service
from mac_host_bridge.tools.logs import get_logs as _get_logs
from mac_host_bridge.tools.health import get_bridge_health as _get_bridge_health
from mac_host_bridge.tools.run_command import run_command
from mac_host_bridge.tools.write_file import write_file
from mac_host_bridge.tools.list_backups import list_backups

host = os.environ.get("MCP_BRIDGE_HOST", "127.0.0.1")
port = int(os.environ.get("MCP_BRIDGE_PORT", "9222"))
mcp = FastMCP("mac-host-bridge", host=host, port=port)


def _timed_call(tool_name: str, fn, inputs: dict):
    t0 = time.time()
    result = fn()
    duration_ms = (time.time() - t0) * 1000
    write_audit_entry(tool_name, inputs, result, duration_ms)
    health_module.CALL_COUNTER += 1
    return result


@mcp.tool()
def get_port_info(
    port: Annotated[int, Field(ge=1, le=65535, description="TCP/UDP port number")],
    protocol: Literal["tcp", "udp"] = "tcp",
) -> dict:
    """Return the process currently holding the specified port, or confirm it is free."""
    inputs = {"port": port, "protocol": protocol}
    return _timed_call("get_port_info", lambda: _get_port_info(port, protocol), inputs)


@mcp.tool()
def list_processes(
    name_filter: str = "",
    limit: Annotated[int, Field(ge=1, le=200)] = 50,
) -> dict:
    """Return a snapshot of running processes, optionally filtered by name substring."""
    inputs = {"name_filter": name_filter, "limit": limit}
    return _timed_call("list_processes", lambda: _list_processes(name_filter, limit), inputs)


@mcp.tool()
def get_system_resources() -> dict:
    """Return current Mac host CPU, memory, and disk utilisation."""
    return _timed_call("get_system_resources", _get_system_resources, {})


@mcp.tool()
def get_service_status(
    service_name: config.ApprovedService,
) -> dict:
    """Return the current launchd state of an approved service (running/stopped/not_loaded)."""
    inputs = {"service_name": service_name.value}
    return _timed_call("get_service_status", lambda: _get_service_status(service_name), inputs)


@mcp.tool()
def get_logs(
    service_name: config.ApprovedService,
    lines: Annotated[int, Field(ge=1, le=500)] = 50,
) -> dict:
    """Return the last N lines of an approved service's log file."""
    inputs = {"service_name": service_name.value, "lines": lines}
    return _timed_call("get_logs", lambda: _get_logs(service_name, lines), inputs)


@mcp.tool()
def get_bridge_health() -> dict:
    """Return bridge liveness, version, uptime, and call metrics."""
    return _timed_call("get_bridge_health", _get_bridge_health, {})


@mcp.tool()
def kill_process_on_port(
    port: Annotated[int, Field(ge=1, le=65535, description="Port to clear")],
    signal: Literal["SIGTERM", "SIGKILL"],
    confirm: bool = False,
    protocol: Literal["tcp", "udp"] = "tcp",
) -> dict:
    """
    Send a signal to the process holding the specified port.
    STATE-CHANGING: requires confirm=True to execute. Returns a dry-run description if confirm=False.
    """
    inputs = {"port": port, "protocol": protocol, "signal": signal, "confirm": confirm}
    return _timed_call(
        "kill_process_on_port",
        lambda: _kill_process_on_port(port, signal, confirm, protocol),
        inputs,
    )


@mcp.tool()
def restart_service(
    service_name: config.ApprovedService,
    confirm: bool = False,
) -> dict:
    """
    Restart an approved launchd service via launchctl kickstart.
    STATE-CHANGING: requires confirm=True to execute. Returns a dry-run description if confirm=False.
    Only services on the approved list can be restarted.
    """
    inputs = {"service_name": service_name.value, "confirm": confirm}
    return _timed_call(
        "restart_service",
        lambda: _restart_service(service_name, confirm),
        inputs,
    )


mcp.tool()(run_command)
mcp.tool()(write_file)
mcp.tool()(list_backups)


def _resolve_lucas_uid() -> str:
    """
    Read LUCAS_UID from the runtime config written by install.sh.
    This is necessary because the server runs as a LaunchDaemon (root), so
    id -u would return 0, not Lucas's actual UID.
    """
    runtime_conf = "/opt/mcp-bridge/config/runtime.conf"
    try:
        with open(runtime_conf, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("LUCAS_UID="):
                    uid = line.split("=", 1)[1].strip()
                    if uid.isdigit():
                        return uid
    except (FileNotFoundError, PermissionError):
        pass

    # Fallback: try id -u (works correctly if not running as root)
    try:
        result = subprocess.run(
            ["id", "-u"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        uid = result.stdout.strip()
        if uid and uid != "0":
            return uid
    except Exception:
        pass

    return ""


def _resolve_user_home(uid: str) -> str:
    """Resolve the home directory for the given UID."""
    try:
        import pwd
        return pwd.getpwuid(int(uid)).pw_dir
    except Exception:
        return ""


def main():
    config.LUCAS_UID = _resolve_lucas_uid()
    if not config.LUCAS_UID:
        print("WARNING: Could not resolve user UID. Service status/restart tools will fail.")

    # Fix log paths that used ~ at import time (expanded to /var/root when running as daemon)
    if config.LUCAS_UID:
        home = _resolve_user_home(config.LUCAS_UID)
        if home:
            config.APPROVED_LOG_PATHS["nanoclaw"] = f"{home}/.pm2/logs/nanoclaw-out.log"
            config.APPROVED_LOG_PATHS["ollama"] = f"{home}/.ollama/logs/server.log"
            config.FALLBACK_LOG_DIR = f"{home}/nanoclaw/logs"

    print(f"mac-host-bridge v{config.VERSION} starting on {host}:{port}")
    print(f"Approved services: {[s.value for s in config.ApprovedService]}")
    print(f"LUCAS_UID: {config.LUCAS_UID}")

    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
