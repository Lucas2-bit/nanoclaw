#!/bin/bash
# NanoClaw watchdog - runs every 2 minutes via crontab
# Checks if NanoClaw is listening on port 3001, restarts if not
if ! /usr/sbin/lsof -i :3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(date): NanoClaw down - restarting" >> /Users/lucascarroll/nanoclaw/logs/watchdog.log
  /opt/homebrew/bin/pm2 restart nanoclaw >> /Users/lucascarroll/nanoclaw/logs/watchdog.log 2>&1
fi
