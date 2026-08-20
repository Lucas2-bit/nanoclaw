from __future__ import annotations
import subprocess
import json
import mac_host_bridge.config as config
import os
if "/opt/homebrew/bin" not in os.environ.get("PATH", "").split(os.pathsep):
    os.environ["PATH"] = "/opt/homebrew/bin" + os.pathsep + os.environ.get("PATH", "")
os.environ.setdefault("PM2_HOME", "/Users/lucascarroll/.pm2")


def _candidate_domains(label: str) -> list[str]:
    """launchd domains to probe for a label, most likely first.

    launchd keeps jobs in separate domains and `launchctl print` will only
    find a job in the domain you name:

      * LaunchDaemons  (/Library/LaunchDaemons)  -> "system"
      * LaunchAgents   (~/Library/LaunchAgents)  -> "gui/<uid>"

    This previously hardcoded gui/<uid>, so every *system* daemon reported as
    "not_loaded" even while running perfectly — including com.mcp-bridge, i.e.
    this bridge describing itself as dead in its own tool output. Probing both
    domains is the fix; ordering is system-first because the approved services
    that are daemons are the ones this got wrong.
    """
    uid = config.LUCAS_UID
    domains = [f"system/{label}"]
    if uid:
        domains.append(f"gui/{uid}/{label}")
    return domains


def _resolve_domain(label: str) -> str | None:
    """Return the first launchd domain that actually has this label, or None."""
    for domain in _candidate_domains(label):
        result = subprocess.run(
            ["launchctl", "print", domain],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return domain
    return None


def _launchctl_print(label: str) -> dict:
    attempts = []
    for domain in _candidate_domains(label):
        result = subprocess.run(
            ["launchctl", "print", domain],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return {
                "returncode": 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "domain": domain,
            }
        attempts.append({"domain": domain, "stderr": result.stderr.strip()})

    if not attempts:
        return {"error": "LUCAS_UID not set — bridge startup incomplete"}

    # Genuinely absent from every domain. Report which domains were tried so a
    # wrong label (the other half of this bug class) is diagnosable from the
    # tool output instead of looking identical to a stopped service.
    return {
        "returncode": 1,
        "stdout": "",
        "stderr": attempts[-1]["stderr"],
        "attempted": attempts,
    }


def _parse_launchctl_state(output: str) -> tuple[str, int | None, int | None]:
    """Parse launchctl print output. Returns (state, pid, last_exit_code)."""
    state = "unknown"
    pid = None
    last_exit = None

    seen_state = False
    seen_pid = False

    for line in output.splitlines():
        line = line.strip()
        if line.startswith("state ="):
            # `launchctl print` nests sub-entries (endpoints, sockets) that each
            # carry their OWN "state =" line at deeper indentation, e.g.
            #     state = running     <- the service
            #         state = active  <- an endpoint
            # Stripping indentation and letting later lines overwrite meant we
            # reported an endpoint's state as the service's. Only the first
            # occurrence is the service itself.
            if seen_state:
                continue
            seen_state = True
            val = line.split("=", 1)[1].strip()
            # Order matters: "not running" CONTAINS "running", so testing for
            # "running" first made the "not running" branch unreachable and
            # reported stopped services as running.
            if "not running" in val:
                state = "stopped"
            elif "running" in val:
                state = "running"
            elif val == "active":
                # Defensive: top-level state should be running/not running/
                # waiting, but treat a top-level "active" as up rather than
                # surfacing it as an unknown state to callers.
                state = "running"
            else:
                state = val
        elif line.startswith("pid ="):
            # Same nesting hazard as state.
            if seen_pid:
                continue
            try:
                pid = int(line.split("=", 1)[1].strip())
                seen_pid = True
            except ValueError:
                pass
        elif line.startswith("last exit code ="):
            try:
                last_exit = int(line.split("=", 1)[1].strip())
            except ValueError:
                pass

    return state, pid, last_exit


PM2_BIN = "/opt/homebrew/bin/pm2"


def _get_pm2_status(service_name: config.ApprovedService) -> dict:
    try:
        raw = subprocess.run([PM2_BIN, "jlist"], capture_output=True, text=True, timeout=10)
    except (subprocess.SubprocessError, OSError) as exc:
        return {"service": service_name.value, "state": "unknown", "error": str(exc)}
    if raw.returncode != 0:
        return {"service": service_name.value, "state": "unknown",
                "error": raw.stderr.strip() or raw.stdout.strip()}
    try:
        procs = json.loads(raw.stdout)
    except json.JSONDecodeError as exc:
        return {"service": service_name.value, "state": "unknown",
                "error": f"pm2 jlist parse failed: {exc}"}
    entry = next((p for p in procs if p.get("name") == service_name.value), None)
    if entry is None:
        return {"service": service_name.value, "state": "not_loaded",
                "pid": None, "last_exit_code": None}
    pm2_env = entry.get("pm2_env", {})
    status = pm2_env.get("status")
    state = "running" if status == "online" else \
            "stopped" if status in ("stopped", "errored") else (status or "unknown")
    return {"service": service_name.value, "state": state,
            "pid": entry.get("pid"), "last_exit_code": pm2_env.get("exit_code")}


def get_service_status(service_name: config.ApprovedService) -> dict:
    if service_name.value == "nanoclaw":
        return _get_pm2_status(service_name)
    label = config.LAUNCHD_LABELS[service_name.value]
    raw = _launchctl_print(label)

    if "error" in raw:
        return raw

    if raw["returncode"] != 0:
        if "Could not find service" in raw["stderr"] or "No such process" in raw["stderr"]:
            return {
                "service": service_name.value,
                "state": "not_loaded",
                "pid": None,
                "last_exit_code": None,
                # Which domains were checked, and the label used. Without this a
                # wrong label is indistinguishable from a stopped service, which
                # is how "ollama: not_loaded" was misread as an outage.
                "label": label,
                "domains_checked": [a["domain"] for a in raw.get("attempted", [])],
            }
        return {
            "service": service_name.value,
            "state": "unknown",
            "error": raw["stderr"].strip(),
            "label": label,
        }

    state, pid, last_exit = _parse_launchctl_state(raw["stdout"])
    return {
        "service": service_name.value,
        "state": state,
        "pid": pid,
        "last_exit_code": last_exit,
        "domain": raw.get("domain"),
    }


def _restart_pm2(service_name: config.ApprovedService, confirm: bool) -> dict:
    if not confirm:
        return {
            "action": "dry_run",
            "description": f"Would run: {PM2_BIN} restart {service_name.value}",
            "service": service_name.value,
            "to_execute": "set confirm=true to proceed",
        }
    try:
        result = subprocess.run(
            [PM2_BIN, "restart", service_name.value],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return {"action": "failed", "service": service_name.value, "error": str(exc)}
    if result.returncode == 0:
        return {
            "action": "restart_issued",
            "service": service_name.value,
            "message": "Restart command accepted. Call get_service_status in ~5s to confirm.",
            "pm2_output": result.stdout.strip(),
        }
    return {
        "action": "failed",
        "service": service_name.value,
        "error": result.stderr.strip() or result.stdout.strip(),
    }


def restart_service(service_name: config.ApprovedService, confirm: bool) -> dict:
    if service_name.value == "nanoclaw":
        return _restart_pm2(service_name, confirm)
    label = config.LAUNCHD_LABELS[service_name.value]
    uid = config.LUCAS_UID

    if not uid:
        return {"error": "LUCAS_UID not set — bridge startup incomplete"}

    # Resolve the real domain rather than assuming gui/<uid>. Kickstarting a
    # system daemon in the gui domain fails, which made restart_service report
    # success-shaped output while doing nothing at all.
    domain = _resolve_domain(label)
    if domain is None:
        return {
            "action": "failed",
            "service": service_name.value,
            "error": f"label '{label}' not found in any launchd domain",
            "domains_checked": _candidate_domains(label),
        }

    if not confirm:
        return {
            "action": "dry_run",
            "description": f"Would run: launchctl kickstart -k {domain}",
            "service": service_name.value,
            "to_execute": "set confirm=true to proceed",
        }

    result = subprocess.run(
        ["launchctl", "kickstart", "-k", domain],
        capture_output=True,
        text=True,
        timeout=30,
    )

    if result.returncode == 0:
        return {
            "action": "restart_issued",
            "service": service_name.value,
            "message": "Restart command accepted. Call get_service_status in ~5s to confirm.",
            "launchctl_output": result.stdout.strip(),
        }
    else:
        return {
            "action": "failed",
            "service": service_name.value,
            "error": result.stderr.strip() or result.stdout.strip(),
        }
