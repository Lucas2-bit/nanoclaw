#!/bin/bash
# NanoClaw watchdog - runs every 2 minutes via crontab
# Monitor-only: logs alerts but does NOT restart.
# pm2 owns the process lifecycle (wait_ready + kill_timeout).
if ! /usr/sbin/lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(date): NanoClaw port 3001 not listening - pm2 should handle restart" >> /Users/lucascarroll/nanoclaw/logs/watchdog.log
fi
