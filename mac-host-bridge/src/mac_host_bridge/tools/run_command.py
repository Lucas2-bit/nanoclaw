import os
import subprocess
from .. import config

_CMD_ENV = {
    **os.environ,
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": "/Users/lucascarroll",
    "PM2_HOME": "/Users/lucascarroll/.pm2",
}


def run_command(command: config.ApprovedCommand, confirm: bool = False) -> dict:
    """Execute a whitelisted Mac-side shell command. confirm=False is a dry-run."""
    cmds = config._approved_commands()
    cmd_str = cmds[command.value]

    if not confirm:
        return {"dry_run": True, "would_execute": cmd_str, "command": command.value}

    try:
        result = subprocess.run(
            cmd_str,
            shell=True,
            executable="/bin/zsh",
            capture_output=True,
            text=True,
            timeout=300,
            env=_CMD_ENV,
        )
        return {
            "stdout":    result.stdout[-4000:] if result.stdout else "",
            "stderr":    result.stderr[-2000:] if result.stderr else "",
            "exit_code": result.returncode,
            "command":   command.value,
        }
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out after 300s", "command": command.value}
    except Exception as e:
        return {"error": str(e), "command": command.value}
