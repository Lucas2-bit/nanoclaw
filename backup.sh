#!/bin/bash
# Nanoclaw Backup Script v2
# Backs up messages.db + ulterior.db locally, uploads to Google Drive.
# Runs daily at 03:00 via launchd (com.nanoclaw.backup.plist)
#
# INSTALL: cp ~/nanoclaw/groups/whatsapp_main/backup.sh ~/nanoclaw/backup.sh
#          chmod +x ~/nanoclaw/backup.sh

PROJECT_DIR="$HOME/nanoclaw"
STORE_DIR="$PROJECT_DIR/store"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG="$BACKUP_DIR/backup.log"
NODE=$(which node || echo "/usr/local/bin/node")

mkdir -p "$BACKUP_DIR"

log() {
  echo "$(date): $1" | tee -a "$LOG"
}

log "=== Backup started ==="

# ── messages.db ──────────────────────────────────────────────────────────────
MESSAGES_SRC="$STORE_DIR/messages.db"
MESSAGES_DEST="$BACKUP_DIR/messages_$TIMESTAMP.db"

if [ -f "$MESSAGES_SRC" ]; then
  sqlite3 "$MESSAGES_SRC" ".backup '$MESSAGES_DEST'"
  MESSAGES_SIZE=$(stat -f%z "$MESSAGES_DEST" 2>/dev/null || stat -c%s "$MESSAGES_DEST" 2>/dev/null || echo 0)
  log "messages.db → $MESSAGES_DEST ($MESSAGES_SIZE bytes)"
else
  log "WARNING: messages.db not found at $MESSAGES_SRC"
  MESSAGES_DEST=""
fi

# ── ulterior.db ───────────────────────────────────────────────────────────────
ULTERIOR_SRC="$STORE_DIR/ulterior.db"
ULTERIOR_DEST="$BACKUP_DIR/ulterior_$TIMESTAMP.db"

if [ -f "$ULTERIOR_SRC" ]; then
  sqlite3 "$ULTERIOR_SRC" ".backup '$ULTERIOR_DEST'"
  ULTERIOR_SIZE=$(stat -f%z "$ULTERIOR_DEST" 2>/dev/null || stat -c%s "$ULTERIOR_DEST" 2>/dev/null || echo 0)
  log "ulterior.db → $ULTERIOR_DEST ($ULTERIOR_SIZE bytes)"

  # Write success entry to backup_log table
  python3 - <<PYEOF
import sqlite3
try:
    conn = sqlite3.connect("$ULTERIOR_SRC")
    conn.execute("""
        INSERT INTO backup_log (backup_path, backup_size_bytes, started_at, completed_at, status)
        VALUES (?, ?, datetime('now'), datetime('now'), 'success')
    """, ("$ULTERIOR_DEST", $ULTERIOR_SIZE))
    conn.commit()
    conn.close()
    print("backup_log entry written to ulterior.db")
except Exception as e:
    print(f"backup_log write failed: {e}")
PYEOF
else
  log "WARNING: ulterior.db not found at $ULTERIOR_SRC"
  ULTERIOR_DEST=""
fi

# ── Google Drive upload ───────────────────────────────────────────────────────
GDRIVE_SCRIPT="$PROJECT_DIR/backup-gdrive-upload.js"

if [ -f "$GDRIVE_SCRIPT" ] && [ -f "$HOME/.gdrive-mcp/credentials.json" ]; then
  log "Uploading to Google Drive..."
  "$NODE" "$GDRIVE_SCRIPT" "$MESSAGES_DEST" "$ULTERIOR_DEST" >> "$LOG" 2>&1
  if [ $? -eq 0 ]; then
    log "Google Drive upload complete"
  else
    log "WARNING: Google Drive upload failed — local backups still intact"
  fi
else
  log "WARNING: Skipping Google Drive upload — script or credentials not found"
fi

# ── Retention: keep last 30 days locally ─────────────────────────────────────
find "$BACKUP_DIR" -name "messages_*.db" -mtime +30 -delete
find "$BACKUP_DIR" -name "ulterior_*.db"  -mtime +30 -delete

log "=== Backup complete ==="
