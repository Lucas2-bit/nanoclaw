import os
import glob
from datetime import datetime
from .. import config


def list_backups() -> dict:
    """List active file backups created by write_file."""
    if not os.path.exists(config.BACKUP_DIR):
        return {"backups": []}

    backups = []
    for f in glob.glob(os.path.join(config.BACKUP_DIR, "*.bak.*")):
        stat = os.stat(f)
        name = os.path.basename(f)
        original = name.split(".bak.")[0]
        backups.append({
            "backup_path":   f,
            "original_name": original,
            "created_at":    datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "size_bytes":    stat.st_size,
        })

    backups.sort(key=lambda x: x["created_at"], reverse=True)
    return {"backups": backups}
