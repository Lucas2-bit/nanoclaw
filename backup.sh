#!/bin/bash
DB_PATH="$HOME/nanoclaw/store/messages.db"
BACKUP_DIR="$HOME/nanoclaw/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/messages_$TIMESTAMP.db"

sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null)

echo "$(date): Backup complete — $BACKUP_FILE ($BACKUP_SIZE bytes)"

# Keep last 30 days only
find "$BACKUP_DIR" -name "messages_*.db" -mtime +30 -delete
