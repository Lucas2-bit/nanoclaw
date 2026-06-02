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
DRY_RUN=0
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
    --dry-run)
      DRY_RUN=1
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

# --- Helpers (defined before use; they reference globals at call time) --
utc_now() { date -u +%FT%TZ; }

# Read a single top-level key out of data/running.json (empty on any error).
read_running() {
  RR_KEY="$1" node -e '
    try {
      const fs = require("fs");
      const info = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
      const v = info[process.env.RR_KEY];
      process.stdout.write(v != null ? String(v) : "");
    } catch { process.stdout.write(""); }
  ' "$RUNNING_INFO"
}

# pm2 status string for nanoclaw ("online"/"stopped"/"missing"/...). Never fails.
pm2_status_str() {
  local json
  json="$("$PM2_BIN" jlist 2>/dev/null || echo '[]')"
  node -e '
    try {
      const list = JSON.parse(process.argv[1] || "[]");
      const nc = list.find(p => p && p.name === "nanoclaw");
      process.stdout.write(nc && nc.pm2_env ? (nc.pm2_env.status || "") : "missing");
    } catch { process.stdout.write("parse-error"); }
  ' "$json"
}

# pm2 wrapper pid for nanoclaw (empty if absent). Never fails.
pm2_pid() {
  local json
  json="$("$PM2_BIN" jlist 2>/dev/null || echo '[]')"
  node -e '
    try {
      const list = JSON.parse(process.argv[1] || "[]");
      const nc = list.find(p => p && p.name === "nanoclaw");
      process.stdout.write(nc && nc.pid != null ? String(nc.pid) : "");
    } catch { process.stdout.write(""); }
  ' "$json"
}

# Returns 0 if something is LISTENing on the given TCP port. lsof -> nc -> node.
port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  else
    node -e '
      const net = require("net");
      const s = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
      const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(2); }, 3000);
      s.once("connect", () => { clearTimeout(t); s.end(); process.exit(0); });
      s.once("error", () => { clearTimeout(t); process.exit(1); });
    ' "$port" >/dev/null 2>&1
  fi
}

# --- :3002 bridge HTTP (curl preferred, node fallback so a missing curl
#     never blocks a smoke or rollback). All return cleanly; callers inspect
#     the output rather than the exit status.
http_post() {
  local path="$1" body="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time 70 -X POST -H 'Content-Type: application/json' \
      --data-binary "$body" "http://127.0.0.1:3002${path}" 2>/dev/null || true
  else
    HTTP_BODY="$body" HTTP_PATH="$path" node -e '
      const http = require("http");
      const body = process.env.HTTP_BODY || "";
      const req = http.request({ host: "127.0.0.1", port: 3002, path: process.env.HTTP_PATH,
        method: "POST", headers: { "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) }, timeout: 70000 },
        res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { process.stdout.write(d); process.exit(0); }); });
      req.on("error", () => process.exit(0));
      req.on("timeout", () => { try { req.destroy(); } catch {} process.exit(0); });
      req.write(body); req.end();
    ' 2>/dev/null || true
  fi
}

http_get_code() {
  local path="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:3002${path}" 2>/dev/null || echo "000"
  else
    HTTP_PATH="$path" node -e '
      const http = require("http");
      const req = http.request({ host: "127.0.0.1", port: 3002, path: process.env.HTTP_PATH, method: "GET", timeout: 10000 },
        res => { process.stdout.write(String(res.statusCode || 0)); res.resume(); res.on("end", () => process.exit(0)); });
      req.on("error", () => { process.stdout.write("000"); process.exit(0); });
      req.on("timeout", () => { try { req.destroy(); } catch {} process.stdout.write("000"); process.exit(0); });
      req.end();
    ' 2>/dev/null || echo "000"
  fi
}

http_get_body() {
  local path="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time 10 "http://127.0.0.1:3002${path}" 2>/dev/null || true
  else
    HTTP_PATH="$path" node -e '
      const http = require("http");
      const req = http.request({ host: "127.0.0.1", port: 3002, path: process.env.HTTP_PATH, method: "GET", timeout: 10000 },
        res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { process.stdout.write(d); process.exit(0); }); });
      req.on("error", () => process.exit(0));
      req.on("timeout", () => { try { req.destroy(); } catch {} process.exit(0); });
      req.end();
    ' 2>/dev/null || true
  fi
}

# Real round-trip smoke of the in-process :3002 claude-task bridge.
#   $1 require_health: 1 = ALSO require GET /health 200 + body status:up
#                      0 = round-trip only (the OLD bridge has no /health)
# PASS only if a POST /claude-task echoes a per-run nonce back through the
# bridge — proving the bridge actually produced output, not merely accepted
# the connection. Returns 0 on pass, nonzero on fail; echoes what it checked.
bridge_smoke() {
  local require_health="${1:-0}"
  local nonce marker prompt body resp code hbody
  nonce="smk-$(date +%s)-$RANDOM"
  marker="DEPLOY_SMOKE_${nonce}"
  prompt="Print exactly this and nothing else: ${marker}"
  body="$(SMOKE_PROMPT="$prompt" node -e '
    process.stdout.write(JSON.stringify({ prompt: process.env.SMOKE_PROMPT || "", wait: true, timeout: 60000 }));
  ' 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    # Fallback hand-build; the prompt has no quotes/backslashes by construction.
    body="{\"prompt\":\"${prompt}\",\"wait\":true,\"timeout\":60000}"
  fi
  echo "bridge_smoke: POST :3002/claude-task (nonce=$nonce, require_health=$require_health)"
  resp="$(http_post /claude-task "$body")"
  if [[ "$resp" != *"$marker"* ]]; then
    echo "bridge_smoke: FAIL — :3002 round-trip did not return '$marker' (empty output or missing nonce)" >&2
    return 1
  fi
  echo "bridge_smoke: OK — :3002 round-trip returned '$marker'"
  if [[ "$require_health" == "1" ]]; then
    code="$(http_get_code /health)"
    if [[ "$code" != "200" ]]; then
      echo "bridge_smoke: FAIL — :3002 GET /health returned HTTP '$code' (expected 200)" >&2
      return 1
    fi
    echo "bridge_smoke: OK — :3002 /health returned HTTP 200"
    hbody="$(http_get_body /health)"
    if [[ "$hbody" != *'"status":"up"'* ]]; then
      echo "bridge_smoke: FAIL — :3002 /health body missing '\"status\":\"up\"'" >&2
      return 1
    fi
    echo "bridge_smoke: OK — :3002 /health body reports status:up"
  fi
  return 0
}

# Atomically write data/deploy-status.json (tmp + mv). Never aborts the script.
#   $1 status  $2 reason(optional)  $3 restored_from(optional)
write_status() {
  local status="$1" reason="${2:-}" restored="${3:-}" ts tmp
  ts="$(utc_now)"
  tmp="${DATA_DIR}/.deploy-status.json.tmp.$$"
  if STATUS_VAL="$status" REASON_VAL="$reason" RESTORED_VAL="$restored" \
     TARGET_VAL="${TARGET_SHA:-}" TS_VAL="$ts" node -e '
       const o = { status: process.env.STATUS_VAL };
       if (process.env.REASON_VAL) o.reason = process.env.REASON_VAL;
       o.target_sha = process.env.TARGET_VAL;
       if (process.env.RESTORED_VAL) o.restored_from = process.env.RESTORED_VAL;
       o.ts = process.env.TS_VAL;
       process.stdout.write(JSON.stringify(o));
     ' > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "${DATA_DIR}/deploy-status.json" 2>/dev/null || true
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 0
}

# Restore the pre-build dist snapshot and bring the OLD bridge back. Called on
# ANY post-restart verify/smoke failure. It exits the script itself (2 = rolled
# back OK, 3 = even the restore failed) so it must never be skipped by set -e —
# every caller invokes it directly, never inside a tested expression.
rollback() {
  local reason="${1:-unspecified}" ok=1 st
  echo "============================================================" >&2
  echo "=== ROLLING BACK ===" >&2
  echo "  reason:         $reason" >&2
  echo "  restoring from: ${ROLLBACK_DIST:-<none>}" >&2
  echo "  prev live SHA:  ${PREV_LIVE_SHA:-<unknown>}" >&2
  echo "============================================================" >&2

  if [[ -z "${ROLLBACK_DIST:-}" || ! -d "${ROLLBACK_DIST:-/nonexistent}" ]]; then
    echo "rollback: CRITICAL — no dist snapshot at '${ROLLBACK_DIST:-<unset>}'; cannot restore" >&2
    write_status "rollback_failed" "$reason (no snapshot)" "${ROLLBACK_DIST:-}"
    echo "CRITICAL: rollback verify failed; leaving pm2 to autorestart, manual attention needed" >&2
    exit 3
  fi

  rm -rf dist || true
  cp -R "$ROLLBACK_DIST" dist || true

  case "$SUPERVISOR" in
    pm2) "$PM2_BIN" restart nanoclaw || true ;;
  esac
  echo "rollback: restored dist; waiting 5s for restart to settle"
  sleep 5

  st="$(pm2_status_str)"
  if [[ "$st" == "online" ]]; then
    echo "rollback: OK — pm2 reports nanoclaw online"
  else
    ok=0; echo "rollback: FAIL — pm2 status '$st' != online" >&2
  fi
  if port_listening "$PORT"; then
    echo "rollback: OK — port $PORT is LISTEN"
  else
    ok=0; echo "rollback: FAIL — nothing listening on port $PORT" >&2
  fi
  # require_health=0: the restored OLD bridge has no /health — the round-trip
  # itself is the proof that it is back.
  if bridge_smoke 0; then
    echo "rollback: OK — restored :3002 bridge round-trip passed"
  else
    ok=0; echo "rollback: FAIL — restored :3002 bridge round-trip failed" >&2
  fi

  if [[ "$ok" -eq 1 ]]; then
    write_status "rolled_back" "$reason" "$ROLLBACK_DIST"
    echo "ROLLED BACK OK"
    exit 2
  fi
  write_status "rollback_failed" "$reason" "$ROLLBACK_DIST"
  echo "CRITICAL: rollback verify failed; leaving pm2 to autorestart, manual attention needed" >&2
  exit 3
}

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

# --- ROLLBACK SNAPSHOT (before build) ----------------------------------
# Copy the CURRENT (about-to-be-replaced) dist/ aside so a bad new bridge can
# be restored without a human. PREV_LIVE_SHA is the SHA the live process
# actually reports — it may differ from HEAD, and that's expected.
ROLLBACK_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_DIST="${DATA_DIR}/rollback/dist-${ROLLBACK_TS}"
PREV_LIVE_SHA=""
if [[ -f "$RUNNING_INFO" ]]; then
  PREV_LIVE_SHA="$(read_running gitSha)"
fi
echo "deploy: snapshot — copying current dist/ -> $ROLLBACK_DIST (prev live SHA: ${PREV_LIVE_SHA:-<unknown>})"
mkdir -p "$(dirname "$ROLLBACK_DIST")"
if [[ -d dist ]]; then
  cp -R dist "$ROLLBACK_DIST"
else
  echo "deploy: WARN — no existing dist/ to snapshot; rollback would have no prior build to restore" >&2
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

# --- DRY RUN (no restart) ----------------------------------------------
# Gate + snapshot + build have run. Smoke the CURRENT live :3002 bridge with a
# round-trip only (the live process is still the OLD in-memory code, which has
# no /health), record status, and exit WITHOUT restarting anything. dist now
# holds the new code; the live process keeps serving the old until a real run.
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "deploy: --dry-run — smoking CURRENT live :3002 bridge (round-trip only, no restart)"
  if ! bridge_smoke 0; then
    echo "deploy: --dry-run FAIL — current live :3002 bridge did not round-trip" >&2
    write_status "dry_run_failed" "live :3002 bridge round-trip failed"
    exit 1
  fi
  write_status "dry_run_ok"
  echo "=== DRY RUN OK (no restart performed) ==="
  exit 0
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

# --- POST-VERIFY --------------------------------------------------------
# Loud verification that the restart actually picked up the new build, then a
# REAL round-trip through the rewritten :3002 bridge. On ANY failure here we
# roll back to the pre-build snapshot — so these checks must never abort via
# set -e before rollback() runs. Each lives inside an `if` and records a
# reason; only after all of (a)(b)(c) are evaluated do we branch to rollback.
echo "deploy: post-verify — waiting 5s for restart to settle"
sleep 5

POST_FAIL=0
POST_REASON=""

# Informational only: pm2 tracks a wrapper pid while the app self-reports its
# own child pid (~18 apart) — they differ BY DESIGN, so a pid change/mismatch
# is NEVER a pass/fail gate. We log it and move on.
NEW_PID="$(pm2_pid)"
if [[ -n "$NEW_PID" && -n "$OLD_PID" && "$NEW_PID" != "$OLD_PID" ]]; then
  echo "deploy: info — pm2 wrapper pid ${OLD_PID} -> ${NEW_PID} (not a gate)"
else
  echo "deploy: info — pm2 wrapper pid=${NEW_PID:-<none>} (app self-reports a different child pid by design; not a gate)"
fi

# (a) pm2 reports nanoclaw online.
PM2_STATUS="$(pm2_status_str)"
if [[ "$PM2_STATUS" == "online" ]]; then
  echo "deploy: post-verify OK — pm2 reports nanoclaw online"
else
  echo "deploy: post-verify FAIL — pm2 status is '$PM2_STATUS', expected 'online'" >&2
  POST_FAIL=1; POST_REASON="${POST_REASON:-pm2 status '$PM2_STATUS' != online}"
fi

# (b) Something is LISTENing on PORT (3001).
if port_listening "$PORT"; then
  echo "deploy: post-verify OK — port $PORT is LISTEN"
else
  echo "deploy: post-verify FAIL — nothing listening on port $PORT" >&2
  POST_FAIL=1; POST_REASON="${POST_REASON:-nothing listening on port $PORT}"
fi

# (c) The LIVE running process reports TARGET_SHA.
#
# We deliberately do NOT read dist/build-info.json here: npm run build just
# stamped it with TARGET_SHA, so a comparison against it is tautological. We
# poll data/running.json, which the process writes from inside the boot path
# AFTER its own checkDistIntegrity (see src/index.ts). We compare gitSha ONLY
# — never pid (see the by-design note above). Poll for up to 30s.
RUNNING_SHA=""
BUILT_AT=""
for ((attempt = 1; attempt <= RUNNING_WAIT_ATTEMPTS; attempt++)); do
  if [[ -f "$RUNNING_INFO" ]]; then
    RUNNING_SHA="$(read_running gitSha)"
    BUILT_AT="$(read_running builtAt)"
    if [[ "$RUNNING_SHA" == "$TARGET_SHA" ]]; then
      break
    fi
  fi
  sleep 2
done

if [[ ! -f "$RUNNING_INFO" ]]; then
  echo "deploy: post-verify FAIL — $RUNNING_INFO not written within $((RUNNING_WAIT_ATTEMPTS * 2))s; live process did not reach boot beacon" >&2
  POST_FAIL=1; POST_REASON="${POST_REASON:-running.json not written}"
elif [[ "$RUNNING_SHA" != "$TARGET_SHA" ]]; then
  echo "deploy: post-verify FAIL — live process reports SHA '$RUNNING_SHA' != target '$TARGET_SHA'" >&2
  POST_FAIL=1; POST_REASON="${POST_REASON:-live SHA '$RUNNING_SHA' != target '$TARGET_SHA'}"
else
  echo "deploy: post-verify OK — live process reports SHA matches target"
fi

# If any of (a)(b)(c) failed, roll back now — no point smoking a bad process.
if [[ "$POST_FAIL" -ne 0 ]]; then
  rollback "$POST_REASON"
fi

# (d) REAL post-swap smoke: the NEW bridge must serve a round-trip AND /health.
if ! bridge_smoke 1; then
  rollback "new :3002 bridge smoke (require_health=1) failed"
fi

# --- GREEN --------------------------------------------------------------
# All of (a)(b)(c)(d) passed. Record green status atomically. The snapshot is
# intentionally left in place for safety.
write_status "deployed_green"
echo "============================================================"
echo "=== DEPLOY GREEN ==="
echo "  sha:      $TARGET_SHA"
echo "  short:    $TARGET_SHORT"
echo "  builtAt:  ${BUILT_AT:-unknown}"
echo "  snapshot: ${ROLLBACK_DIST:-<none>} (kept for safety)"
echo "============================================================"
exit 0
