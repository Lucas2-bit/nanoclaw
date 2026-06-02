#!/usr/bin/env bash
# scripts/deploy.sh — the ONLY path that builds-then-restarts NanoClaw.
#
# Atomic and gated: gate checks (typecheck / tests / secret scan) run BEFORE
# we touch the live process. If any gate fails the running system stays up
# untouched. Only after gates pass do we build and restart, then loudly
# verify the running process is actually the SHA we intended to deploy.
#
# Safe to re-run: a stale ${DATA_DIR}/.deploy.lock is cleared by the trap on
# any exit path (success, gate failure, build failure, post-verify failure,
# or interrupt) so the watchdog never sees a leftover lock.
set -euo pipefail

# --- Args ---------------------------------------------------------------
COMMIT_REF=""
ALLOW_DIRTY=0
SKIP_TESTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      COMMIT_REF="${2:-}"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    *)
      echo "deploy: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# --- Env overrides ------------------------------------------------------
SUPERVISOR="${SUPERVISOR:-pm2}"
PM2_BIN="${PM2_BIN:-/opt/homebrew/bin/pm2}"

# --- Locate repo root ---------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DATA_DIR="$REPO_ROOT/data"
LOCK_FILE="$DATA_DIR/.deploy.lock"
BUILD_INFO="$REPO_ROOT/dist/build-info.json"
RUNNING_INFO="$DATA_DIR/running.json"
PORT=3001
# How long to wait for the new process to write data/running.json after
# pm2 restart. Indexed by attempts × 2s sleep.
RUNNING_WAIT_ATTEMPTS=15

mkdir -p "$DATA_DIR"

# --- Lock ---------------------------------------------------------------
# The watchdog skips the git-integrity check while this lock exists, so a
# mid-deploy SHA divergence is not reported as drift. Trap on EXIT (any
# code path, including interrupts) so we never leave a stale lock behind.
echo "$$ $(date -u +%FT%TZ)" > "$LOCK_FILE"
cleanup() {
  rm -f "$LOCK_FILE"
}
trap cleanup EXIT INT TERM

# --- Precondition: clean tree (unless --allow-dirty) -------------------
if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "deploy: FAIL — working tree is dirty. Commit/stash or pass --allow-dirty." >&2
    git status --short >&2
    exit 1
  fi
fi

# --- Optional checkout --------------------------------------------------
if [[ -n "$COMMIT_REF" ]]; then
  echo "deploy: checking out $COMMIT_REF"
  git checkout "$COMMIT_REF"
fi

TARGET_SHA="$(git rev-parse HEAD)"
TARGET_SHORT="$(git rev-parse --short HEAD)"
echo "deploy: target SHA $TARGET_SHA ($TARGET_SHORT)"

# --- GATE (live system stays up on any failure) ------------------------
# Order: cheapest signal first, secrets last because the scanner walks the
# whole repo. Anything non-zero here aborts BEFORE the build or restart.
echo "deploy: gate 1/3 — typecheck"
if ! npm run typecheck; then
  echo "deploy: FAIL — typecheck failed; live process untouched" >&2
  exit 1
fi

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  echo "deploy: gate 2/3 — tests"
  if ! npm test; then
    echo "deploy: FAIL — tests failed; live process untouched" >&2
    exit 1
  fi
else
  echo "deploy: gate 2/3 — tests SKIPPED (--skip-tests)"
fi

echo "deploy: gate 3/3 — secret scan"
if ! npm run scan:secrets; then
  echo "deploy: FAIL — secret scan flagged a hit; live process untouched" >&2
  exit 1
fi

# --- BUILD --------------------------------------------------------------
# postbuild (scripts/gen-build-info.cjs) stamps dist/build-info.json with
# the current HEAD SHA and contentHash. The build is the moment dist/ gets
# repointed to TARGET_SHA; everything below is verification.
echo "deploy: building"
if ! npm run build; then
  echo "deploy: FAIL — build failed; live process untouched (no restart issued)" >&2
  exit 1
fi

# --- RESTART ------------------------------------------------------------
# Remove the prior beacon so a process that fails to boot can't be mistaken
# for a successful restart. The new process re-creates this on every boot
# (see src/index.ts after checkDistIntegrity).
rm -f "$RUNNING_INFO"

OLD_PID=""
case "$SUPERVISOR" in
  pm2)
    PM2_JSON_PRE="$("$PM2_BIN" jlist 2>/dev/null || echo '[]')"
    OLD_PID="$(node -e "
      try {
        const list = JSON.parse(process.argv[1] || '[]');
        const nc = list.find(p => p && p.name === 'nanoclaw');
        process.stdout.write(nc && nc.pid != null ? String(nc.pid) : '');
      } catch { process.stdout.write(''); }
    " "$PM2_JSON_PRE")"
    echo "deploy: restarting via pm2 ($PM2_BIN) — old pid=${OLD_PID:-<none>}"
    "$PM2_BIN" restart nanoclaw
    ;;
  # NOTE: launchctl path is a deliberate stub. pm2 is the production
  # supervisor today; this elif exists so a future macOS LaunchAgent
  # deployment can wire its restart command here without touching the rest
  # of the script. Leave the explicit error so it can't be selected by
  # accident before being implemented.
  launchctl)
    echo "deploy: FAIL — launchctl supervisor path is a stub, not implemented" >&2
    exit 1
    ;;
  *)
    echo "deploy: FAIL — unknown SUPERVISOR='$SUPERVISOR' (expected pm2 or launchctl)" >&2
    exit 1
    ;;
esac

# --- POST-VERIFY (M4) ---------------------------------------------------
# Loud verification that the restart actually picked up the new build.
# Three independent checks; any failure prints FAIL and exits non-zero.
echo "deploy: post-verify — waiting 5s for restart to settle"
sleep 5

POST_FAIL=0

# (a) pm2 reports nanoclaw online.
case "$SUPERVISOR" in
  pm2)
    if PM2_JSON="$("$PM2_BIN" jlist 2>/dev/null)"; then
      # Parse with node so we don't need jq on the deploy host.
      PM2_STATUS="$(node -e "
        try {
          const list = JSON.parse(process.argv[1] || '[]');
          const nc = list.find(p => p && p.name === 'nanoclaw');
          process.stdout.write(nc && nc.pm2_env ? (nc.pm2_env.status || '') : 'missing');
        } catch { process.stdout.write('parse-error'); }
      " "$PM2_JSON")"
      if [[ "$PM2_STATUS" != "online" ]]; then
        echo "deploy: post-verify FAIL — pm2 status is '$PM2_STATUS', expected 'online'" >&2
        POST_FAIL=1
      else
        echo "deploy: post-verify OK — pm2 reports nanoclaw online"
      fi
      NEW_PID="$(node -e "
        try {
          const list = JSON.parse(process.argv[1] || '[]');
          const nc = list.find(p => p && p.name === 'nanoclaw');
          process.stdout.write(nc && nc.pid != null ? String(nc.pid) : '');
        } catch { process.stdout.write(''); }
      " "$PM2_JSON")"
      if [[ -z "$NEW_PID" || ! "$NEW_PID" =~ ^[0-9]+$ || "$NEW_PID" -le 0 ]]; then
        echo "deploy: post-verify FAIL — new pid '${NEW_PID:-<empty>}' is not a positive integer; process did not re-exec cleanly" >&2
        POST_FAIL=1
      elif [[ "$NEW_PID" == "$OLD_PID" ]]; then
        echo "deploy: post-verify FAIL — pid unchanged after restart (still $NEW_PID); process did not re-exec" >&2
        POST_FAIL=1
      else
        echo "deploy: post-verify OK — pid changed ${OLD_PID:-<none>} -> $NEW_PID"
      fi
    else
      echo "deploy: post-verify FAIL — pm2 jlist failed" >&2
      POST_FAIL=1
    fi
    ;;
esac

# (b) Port 3001 is in LISTEN state. lsof first (it's how the watchdog
# checks); nc as a fallback if lsof is missing.
if command -v lsof >/dev/null 2>&1; then
  if lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "deploy: post-verify OK — port $PORT is LISTEN"
  else
    echo "deploy: post-verify FAIL — nothing listening on port $PORT" >&2
    POST_FAIL=1
  fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    echo "deploy: post-verify OK — port $PORT is reachable (nc)"
  else
    echo "deploy: post-verify FAIL — nothing reachable on port $PORT (nc)" >&2
    POST_FAIL=1
  fi
else
  if node -e "
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port: Number(process.argv[1]) });
    const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(2); }, 3000);
    s.once('connect', () => { clearTimeout(t); s.end(); process.exit(0); });
    s.once('error', () => { clearTimeout(t); process.exit(1); });
  " "$PORT" >/dev/null 2>&1; then
    echo "deploy: post-verify OK — port $PORT is reachable (node TCP)"
  else
    echo "deploy: post-verify FAIL — node TCP connect to 127.0.0.1:$PORT failed (no lsof/nc available)" >&2
    POST_FAIL=1
  fi
fi

# (c) The LIVE running process reports TARGET_SHA.
#
# We deliberately do NOT read dist/build-info.json here: npm run build just
# stamped it with TARGET_SHA, so a comparison against it is tautological and
# tells us nothing about whether the running process actually loaded the new
# build. Instead we poll data/running.json, which the process writes from
# inside the boot path AFTER its own checkDistIntegrity (see src/index.ts).
# The pid in that file proves the new pm2 child wrote it; the gitSha proves
# what the live process actually loaded from dist/.
RUNNING_SHA=""
RUNNING_PID_REPORTED=""
BUILT_AT=""
for ((attempt = 1; attempt <= RUNNING_WAIT_ATTEMPTS; attempt++)); do
  if [[ -f "$RUNNING_INFO" ]]; then
    RUNNING_SHA="$(node -e "
      try {
        const fs = require('fs');
        const info = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        process.stdout.write(info.gitSha || '');
      } catch { process.stdout.write(''); }
    " "$RUNNING_INFO")"
    RUNNING_PID_REPORTED="$(node -e "
      try {
        const fs = require('fs');
        const info = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        process.stdout.write(info.pid != null ? String(info.pid) : '');
      } catch { process.stdout.write(''); }
    " "$RUNNING_INFO")"
    BUILT_AT="$(node -e "
      try {
        const fs = require('fs');
        const info = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        process.stdout.write(info.builtAt || '');
      } catch { process.stdout.write(''); }
    " "$RUNNING_INFO")"
    # We need a beacon written by the *new* pm2 child. If the pid matches
    # NEW_PID we're done; if it still matches OLD_PID, the new process
    # hasn't yet overwritten the file (or, if we deleted it pre-restart,
    # the OS hasn't yet flushed the new write) — keep waiting.
    if [[ -n "$RUNNING_PID_REPORTED" && "$RUNNING_PID_REPORTED" == "$NEW_PID" ]]; then
      break
    fi
  fi
  sleep 2
done

if [[ ! -f "$RUNNING_INFO" ]]; then
  echo "deploy: post-verify FAIL — $RUNNING_INFO not written within $((RUNNING_WAIT_ATTEMPTS * 2))s; live process did not reach boot beacon" >&2
  POST_FAIL=1
elif [[ -z "$RUNNING_PID_REPORTED" ]]; then
  echo "deploy: post-verify FAIL — running.json has no pid; live beacon unreadable" >&2
  POST_FAIL=1
elif [[ "$RUNNING_PID_REPORTED" != "$NEW_PID" ]]; then
  echo "deploy: post-verify FAIL — running.json pid '$RUNNING_PID_REPORTED' != new pm2 pid '$NEW_PID'; new process never wrote its beacon" >&2
  POST_FAIL=1
elif [[ "$RUNNING_SHA" != "$TARGET_SHA" ]]; then
  echo "deploy: post-verify FAIL — live process reports SHA '$RUNNING_SHA' != target '$TARGET_SHA'" >&2
  POST_FAIL=1
else
  echo "deploy: post-verify OK — live process (pid $NEW_PID) reports SHA matches target"
fi

if [[ "$POST_FAIL" -ne 0 ]]; then
  echo "deploy: FAIL — one or more post-verify checks failed" >&2
  exit 1
fi

# --- PASS --------------------------------------------------------------
echo "============================================================"
echo "deploy: PASS"
echo "  sha:      $TARGET_SHA"
echo "  short:    $TARGET_SHORT"
echo "  builtAt:  ${BUILT_AT:-unknown}"
echo "============================================================"
exit 0
