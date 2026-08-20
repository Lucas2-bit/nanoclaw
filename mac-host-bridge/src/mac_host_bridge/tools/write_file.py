import os
import shutil
from datetime import datetime
from .. import config


def write_file(path: str, content: str, confirm: bool = False) -> dict:
    """Write a file on the Mac, scoped to approved prefixes. confirm=False is a dry-run."""
    expanded = os.path.realpath(os.path.expanduser(path))

    # Scope check — symlink-safe (realpath already resolved)
    if not any(expanded.startswith(p) for p in config.APPROVED_WRITE_PREFIXES):
        return {
            "error":           f"Path not in approved scope: {path}",
            "approved_scopes": config.APPROVED_WRITE_PREFIXES,
        }

    # Size check
    encoded = content.encode()
    if len(encoded) > config.MAX_WRITE_SIZE_BYTES:
        return {"error": f"Content exceeds {config.MAX_WRITE_SIZE_BYTES // 1024} KB limit"}

    if not confirm:
        current_lines = 0
        if os.path.exists(expanded):
            with open(expanded) as f:
                current_lines = sum(1 for _ in f)
        return {
            "dry_run":       True,
            "path":          expanded,
            "file_exists":   os.path.exists(expanded),
            "current_lines": current_lines,
            "new_lines":     len(content.splitlines()),
        }

    # Backup existing file before overwriting
    backup_path = None
    if os.path.exists(expanded):
        os.makedirs(config.BACKUP_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = os.path.basename(expanded) + f".bak.{ts}"
        backup_path = os.path.join(config.BACKUP_DIR, backup_name)
        shutil.copy2(expanded, backup_path)

    os.makedirs(os.path.dirname(expanded), exist_ok=True)
    with open(expanded, "w") as f:
        f.write(content)

    return {
        "success":       True,
        "path":          expanded,
        "bytes_written": len(encoded),
        "backup_path":   backup_path,
    }
