#!/bin/bash
# Clear both credential proxy (3001) and task server (3002) ports
for port in 3001 3002; do
  pids=$(lsof -ti :$port 2>/dev/null)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
done
sleep 1
exec /opt/homebrew/bin/node /Users/lucascarroll/nanoclaw/dist/index.js
