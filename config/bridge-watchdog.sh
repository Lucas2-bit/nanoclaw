#!/bin/bash
# Bridge restart watchdog - auto-restart if bridge not healthy after 5 min
sleep 300
if curl -sf http://127.0.0.1:9222/health >/dev/null 2>&1; then
  echo "$(date): Bridge healthy, no action needed" >> /tmp/bridge-watchdog.log
else
  echo "$(date): Bridge not responding, restarting..." >> /tmp/bridge-watchdog.log
  sudo launchctl kickstart -k system/com.mcp-bridge 2>&1 >> /tmp/bridge-watchdog.log
fi
