#!/bin/bash
# Remove duplicate watchdog cron entries, keep only backup
crontab -l | grep -v watchdog > /tmp/crontab_clean.txt
crontab /tmp/crontab_clean.txt
echo "Done. Current crontab:"
crontab -l
