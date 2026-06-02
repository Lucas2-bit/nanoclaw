#!/bin/bash
# watchdog.sh — DEPRECATED / NEUTERED (2026-06-02, Supervisor Split keystone)
#
# This script previously ran pm2 restart nanoclaw. It has been neutered as
# part of the MF1/D3 deny-self-lifecycle work.
#
# The active supervisor is watchdog-v2.cjs, managed by pm2 as the watchdog app.
echo "[watchdog.sh] DEPRECATED: this script is neutered. The supervisor is watchdog-v2.cjs." >&2
exit 1
