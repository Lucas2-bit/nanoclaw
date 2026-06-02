// watchdog-v2.cjs
// RESPONSIBILITIES: Supervisor — Monitor, Alert, AND bounded restart authority.
// Managed by pm2 as a separate app named 'watchdog'.
//
// DELIBERATE CONTRACT REVISION (2026-06-02, Supervisor Split keystone):
// This file PREVIOUSLY said "Never restarts anything." That contract is
// intentionally revised here. Restart authority is now added, bounded by:
//   - D2: auto-restart ONLY on confirmed tick-stall (event-loop hang),
//         gated by MF3 (pm2 not spiking/abandoned) + MF4 (cooldown N=2/15min).
//   - 90-min backstop (oldestActiveStartedAt): PAGE Lucas, do NOT auto-restart.
//   - D1: zero successful completions in rolling window: PAGE Lucas.
//   - MF3 pm2-abandoned: PAGE Lucas, STOP actuating.
//   - MF4 ceiling (N=2 restarts/15min): STOP + PAGE Lucas.
// INV-3 enforcement: this file may NOT be stopped/killed/restarted via the
// agent's mac-host-bridge approved-command set. The agent keeps nanoclaw_restart
// for self-restart requests, but has NO lifecycle verbs against the watchdog.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const {
  classifyQueueState: classifyQueueStatePure,
  checkRestartAllowed: checkRestartAllowedPure,
  evaluateD1Alarm,
  isPageOnlyReason,
} = require('./watchdog-logic.cjs');

// --- Configuration ---
const CHECK_INTERVAL_MS = 60_000;
const DEGRADED_INTERVAL_MS = 300_000;
const PORT = 3001;
const CLAUDE_TASK_PORT = parseInt(process.env.CLAUDE_TASK_PORT || '3002', 10);
const ALERT_LOG = path.join(__dirname, '..', 'logs', 'watchdog-alerts.log');
const ALERT_PICKUP_DIR = path.join(__dirname, '..', 'logs', 'alerts');
const MAX_SELF_FAILURES = 3;
const RESTART_SPIKE_THRESHOLD = 5;
const RESTART_SPIKE_WINDOW_MIN = 10;

// Queue-state file written by GroupQueue (atomic temp+rename).
const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_STATE_PATH = path.join(DATA_DIR, 'queue-state.json');
const DATA_ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const DEPLOY_LOCK_PATH = path.join(DATA_DIR, '.deploy.lock');
const INTEGRITY_ALERT_COOLDOWN_MS = 30 * 60_000;

// D2: Tick-stall thresholds.
// The heartbeat tick fires every 90s. Stale > 3 * interval = genuinely hung.
const TICK_INTERVAL_MS = 90_000; // must match QUEUE_STATE_TICK_INTERVAL_MS in group-queue.ts
const TICK_STALE_THRESHOLD_MS = parseInt(
  process.env.TICK_STALE_THRESHOLD_MS || String(3 * TICK_INTERVAL_MS),
  10,
); // default 270s
// 90-min backstop: oldest active run beyond this = page, not restart.
const OLDEST_ACTIVE_BACKSTOP_MS = parseInt(
  process.env.OLDEST_ACTIVE_BACKSTOP_MS || String(90 * 60_000),
  10,
);

// D1: Zero-successful-runs alarm window (default 30 min).
const ZERO_SUCCESS_ALARM_WINDOW_MS = parseInt(
  process.env.ZERO_SUCCESS_ALARM_WINDOW_MS || String(30 * 60_000),
  10,
);

// MF4: Restart cooldown + ceiling.
const RESTART_COOLDOWN_N = parseInt(process.env.RESTART_COOLDOWN_N || '2', 10);
const RESTART_COOLDOWN_WINDOW_MS = parseInt(
  process.env.RESTART_COOLDOWN_WINDOW_MS || String(15 * 60_000),
  10,
);

// Post-restart end-to-end probe: how long to wait for nanoclaw to come back up.
const PROBE_WAIT_MS = parseInt(process.env.PROBE_WAIT_MS || '30000', 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '10000', 10);

// Git-integrity check is loaded from compiled dist/. If dist isn't built yet
// (fresh checkout, mid-deploy) we emit one advisory and continue — the rest
// of the watchdog must keep running.
let integrityModule = null;
let integrityLoadError = null;
try {
  integrityModule = require(path.join(__dirname, '..', 'dist', 'integrity.js'));
} catch (e) {
  integrityLoadError = e;
}

// --- State ---
let selfFailures = 0;
let currentInterval = CHECK_INTERVAL_MS;
let lastRestartCount = null;
let restartHistory = [];

// Git-integrity dedup: only re-alert on (a) state transition between
// ok<->drift or (b) the same drift persisting for >= 30 min.
let lastIntegrityState = { ok: null, key: null, lastAlertAt: 0 };
let integrityModuleMissingAlerted = false;

// MF4: Restart history for cooldown tracking.
// Each entry: { ts: number }. Counter resets ONLY on verified e2e success.
let supervisorRestartHistory = [];
// Whether the cooldown ceiling has been hit and we have stopped actuating.
let restartCeilingHit = false;

// D1: track when we last fired the zero-success alarm (dedup).
let lastZeroSuccessAlarmAt = 0;
// Track when we last fired the 90-min backstop page (dedup).
let lastBackstopPageAt = 0;

// --- Alert Levels ---
const LEVEL = { INFO: 'INFO', WARN: 'WARN', CRITICAL: 'CRITICAL' };

function alert(level, component, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(data || {}),
  };
  const line = JSON.stringify(entry);
  try {
    fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
    fs.appendFileSync(ALERT_LOG, line + '\n');
  } catch (e) {
    console.error('Failed to write alert log:', e.message);
  }
  if (level !== LEVEL.INFO) {
    try {
      fs.mkdirSync(ALERT_PICKUP_DIR, { recursive: true });
      const filename = `${Date.now()}-${level}.json`;
      fs.writeFileSync(path.join(ALERT_PICKUP_DIR, filename), line);
    } catch (e) {
      console.error('Failed to write alert pickup:', e.message);
    }
  }
}

// --- Checks ---

function checkPort() {
  try {
    execSync(`lsof -i :${PORT} -sTCP:LISTEN -t`, { timeout: 5000, stdio: 'pipe' });
    return { healthy: true };
  } catch (_e) {
    return { healthy: false, message: `Port ${PORT} not listening` };
  }
}

function writeIntegrityAlertFile(message) {
  try {
    fs.mkdirSync(DATA_ALERTS_DIR, { recursive: true });
    const filename = `git-integrity-${Date.now()}.txt`;
    fs.writeFileSync(path.join(DATA_ALERTS_DIR, filename), message, 'utf-8');
  } catch (e) {
    alert(LEVEL.WARN, 'git-integrity', `failed to write alert file: ${e.message}`);
  }
}

function checkGitIntegrity() {
  // One-shot advisory if the compiled module isn't available — keeps the
  // rest of the watchdog functional.
  if (!integrityModule) {
    if (!integrityModuleMissingAlerted) {
      integrityModuleMissingAlerted = true;
      const msg = `integrity-module-missing: dist/integrity.js not loadable (${integrityLoadError && integrityLoadError.message})`;
      alert(LEVEL.WARN, 'git-integrity', msg);
      writeIntegrityAlertFile(msg);
    }
    return;
  }

  // Deploy in progress — a mid-deploy SHA divergence is expected, not a fault.
  if (fs.existsSync(DEPLOY_LOCK_PATH)) {
    return;
  }

  let result;
  try {
    result = integrityModule.checkDistIntegrity();
  } catch (e) {
    // checkDistIntegrity is documented to never throw, but defense in depth.
    alert(LEVEL.WARN, 'git-integrity', `check threw (ignored): ${e.message}`);
    return;
  }

  const reasonCodes = (result.reasons || [])
    .map((r) => r.code)
    .sort()
    .join(',');
  const buildSha = (result.details && result.details.buildSha) || '';
  const headSha = (result.details && result.details.headSha) || '';
  const key = `${reasonCodes}|${buildSha}|${headSha}`;

  const now = Date.now();
  const stateChanged = lastIntegrityState.ok !== result.ok;
  const keyChanged = lastIntegrityState.key !== key;
  const cooledDown =
    now - lastIntegrityState.lastAlertAt >= INTEGRITY_ALERT_COOLDOWN_MS;

  // Always fire on transition; otherwise only re-fire on drift if key
  // changed OR cooldown elapsed.
  let shouldAlert = false;
  if (stateChanged) {
    shouldAlert = true;
  } else if (!result.ok && (keyChanged || cooledDown)) {
    shouldAlert = true;
  }

  if (shouldAlert) {
    const body = formatIntegrityMessage(result);
    if (!result.ok) {
      alert(LEVEL.CRITICAL, 'git-integrity', 'dist integrity drift', {
        reasonCodes,
        buildSha,
        headSha,
      });
    } else {
      // Transitioned back to ok — log INFO, no pickup file needed for green.
      alert(LEVEL.INFO, 'git-integrity', 'dist integrity recovered', {
        reasonCodes,
      });
    }
    if (!result.ok) writeIntegrityAlertFile(body);
    lastIntegrityState = { ok: result.ok, key, lastAlertAt: now };
  } else {
    lastIntegrityState.ok = result.ok;
    lastIntegrityState.key = key;
  }
}

function formatIntegrityMessage(result) {
  if (
    integrityModule &&
    typeof integrityModule.formatIntegrityMessage === 'function'
  ) {
    try {
      return integrityModule.formatIntegrityMessage(result);
    } catch (_e) {
      /* fall through to local formatter */
    }
  }
  const lines = [`dist integrity ${result.ok ? 'advisory' : 'drift'}`];
  for (const r of result.reasons || []) {
    lines.push(`- [${r.severity}] ${r.code}: ${r.message}`);
  }
  lines.push(`details: ${JSON.stringify(result.details || {})}`);
  return lines.join('\n');
}

/**
 * MF3: Check pm2 state of nanoclaw.
 *
 * Returns:
 *   { healthy: true,  abandoned: false, status, restartCount, unstableRestarts, uptime }
 *   { healthy: false, abandoned: true,  ... }  -- pm2 hit max_restarts (errored)
 *   { healthy: false, abandoned: false, message } -- offline but recoverable
 *   { healthy: false, abandoned: false, message } -- query failed
 */
function checkPm2Status() {
  try {
    const raw = execSync('pm2 jlist', {
      timeout: 10000,
      stdio: 'pipe',
    }).toString();
    const procs = JSON.parse(raw);
    const nc = procs.find((p) => p.name === 'nanoclaw');
    if (!nc) {
      return {
        healthy: false,
        abandoned: false,
        message: 'nanoclaw not found in pm2',
      };
    }
    const env = nc.pm2_env || {};
    const restartCount = env.restart_time || 0;
    const unstableRestarts = env.unstable_restarts || 0;
    // pm2 max_restarts is 10 by default (ecosystem.config.cjs).
    // status === 'errored' means pm2 gave up after hitting max_restarts.
    const abandoned = unstableRestarts >= 10 || env.status === 'errored';
    return {
      healthy: env.status === 'online',
      abandoned,
      status: env.status,
      restartCount,
      unstableRestarts,
      uptime: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
    };
  } catch (e) {
    return {
      healthy: false,
      abandoned: false,
      message: `pm2 query failed: ${e.message}`,
    };
  }
}

/**
 * Read queue-state.json, tolerating missing/corrupt files.
 * Returns null if the file cannot be read (nanoclaw has not started yet or
 * crashed before writing state).
 */
function readQueueState() {
  try {
    const raw = fs.readFileSync(QUEUE_STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * D2: Classify the current queue state.
 *
 * idle  -- activeCount === 0. Normal rest state.
 * busy  -- activeCount > 0 AND tick_ts fresh. Legitimately working. Never restart.
 * hung  -- activeCount > 0 AND tick_ts stale. Event loop stalled. Auto-restart.
 * no-state -- queue-state.json absent/unreadable. Cannot classify.
 *
 * Clock-step tolerant: negative age (NTP step forward) treated as stale.
 * Sleep/wake tolerant: massively stale tick also triggers correctly.
 */
function classifyQueueState(qs) {
  // Delegates to the pure module (src/watchdog-logic.cjs) so the unit tests
  // exercise the SAME code path that ships here.
  return classifyQueueStatePure(qs, TICK_STALE_THRESHOLD_MS, Date.now());
}

/**
 * MF4: Check if a supervisor restart is permitted by the cooldown/ceiling policy.
 * Returns { allowed: true } or { allowed: false, reason: 'ceiling-hit' | 'cooldown-exceeded' }.
 */
function checkRestartAllowed() {
  const now = Date.now();
  // Prune the in-memory history first (the pure fn is side-effect free).
  supervisorRestartHistory = supervisorRestartHistory.filter(
    (r) => r.ts > now - RESTART_COOLDOWN_WINDOW_MS,
  );
  return checkRestartAllowedPure(
    { ceilingHit: restartCeilingHit, history: supervisorRestartHistory },
    RESTART_COOLDOWN_N,
    RESTART_COOLDOWN_WINDOW_MS,
    now,
  );
}

/**
 * SHOULD-FIX D: End-to-end health probe via the claude-task bridge (port 3002).
 *
 * Sends a minimal real task through the bridge to verify the full agent spawn
 * path is functional, not just that the node process is alive. A process can
 * be alive but completely unable to handle work (the 05-31 class).
 *
 * Returns a promise: { ok: boolean, detail: string }.
 */
function runE2eProbe() {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      resolve({
        ok: false,
        detail: `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
      });
    }, PROBE_TIMEOUT_MS);

    const body = JSON.stringify({ prompt: 'echo probe-ok', timeout: 8000 });
    const options = {
      hostname: '127.0.0.1',
      port: CLAUDE_TASK_PORT,
      path: '/claude-task',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        clearTimeout(deadline);
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok === true) {
            resolve({ ok: true, detail: 'claude-task bridge responded ok' });
          } else {
            // ok:false means bridge busy or error — process is up but not serving.
            resolve({
              ok: false,
              detail: `bridge returned ok:false: ${parsed.error || '?'}`,
            });
          }
        } catch (e) {
          resolve({ ok: false, detail: `probe JSON parse error: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(deadline);
      resolve({ ok: false, detail: `probe connection error: ${e.message}` });
    });

    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      clearTimeout(deadline);
      resolve({ ok: false, detail: 'probe request timed out' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Issue a supervised restart of nanoclaw via pm2, then verify with the e2e probe.
 *
 * Gated by MF3 (pm2 not abandoned/spiking) + MF4 (cooldown + ceiling).
 * MF4 counter resets ONLY on verified e2e success.
 * All outcomes written to the alert log; CRITICAL written to pickup dir (pages Lucas).
 */
async function supervisedRestart(reason) {
  // MF4: check cooldown + ceiling before acting.
  const allowed = checkRestartAllowed();
  if (!allowed.allowed) {
    if (allowed.reason === 'cooldown-exceeded') {
      // Transition to ceiling-hit: stop actuating, page Lucas.
      restartCeilingHit = true;
      alert(
        LEVEL.CRITICAL,
        'supervisor',
        `Restart ceiling hit: ${RESTART_COOLDOWN_N} restarts in ${RESTART_COOLDOWN_WINDOW_MS / 60000}min window. Stopping actuation. PAGE LUCAS.`,
        {
          restarts: supervisorRestartHistory.length,
          windowMs: RESTART_COOLDOWN_WINDOW_MS,
          reason,
        },
      );
    }
    // ceiling-hit already paged. Either way, do not restart.
    return;
  }

  // MF3: Check pm2 state before issuing restart.
  const pm2 = checkPm2Status();
  if (pm2.abandoned) {
    // pm2 has given up. A supervisor restart would be futile. PAGE LUCAS.
    restartCeilingHit = true;
    alert(
      LEVEL.CRITICAL,
      'supervisor',
      'nanoclaw pm2-abandoned (max_restarts hit or errored). Human intervention required. PAGE LUCAS.',
      {
        pm2Status: pm2.status,
        unstableRestarts: pm2.unstableRestarts,
        reason,
      },
    );
    return;
  }

  // Check for active pm2 restart spike (pm2 already looping).
  if (
    pm2.restartCount !== undefined &&
    lastRestartCount !== null &&
    pm2.restartCount > lastRestartCount + 3
  ) {
    alert(LEVEL.WARN, 'supervisor', 'Skipping supervisor restart: pm2 already spiking', {
      lastKnownRestarts: lastRestartCount,
      currentRestarts: pm2.restartCount,
      reason,
    });
    return;
  }

  // Record this restart attempt (MF4 window tracking).
  const now = Date.now();
  supervisorRestartHistory.push({ ts: now });
  alert(
    LEVEL.WARN,
    'supervisor',
    `Issuing supervised restart (reason: ${reason}). Attempt ${supervisorRestartHistory.length}/${RESTART_COOLDOWN_N} in window.`,
  );

  try {
    execSync('/opt/homebrew/bin/pm2 restart nanoclaw 2>&1', {
      timeout: 15000,
      stdio: 'pipe',
    });
    alert(LEVEL.INFO, 'supervisor', 'pm2 restart command issued. Waiting for process to initialise.');
  } catch (e) {
    alert(
      LEVEL.CRITICAL,
      'supervisor',
      `pm2 restart failed: ${e.message}. PAGE LUCAS.`,
      { reason },
    );
    return;
  }

  // Wait for the process to come up before probing.
  await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS));

  // SHOULD-FIX D: Real e2e probe — not just "is the port open."
  const probe = await runE2eProbe();
  if (probe.ok) {
    // MF4: Counter resets ONLY on verified e2e success.
    supervisorRestartHistory = [];
    restartCeilingHit = false;
    alert(
      LEVEL.INFO,
      'supervisor',
      `Post-restart e2e probe passed: ${probe.detail}. Restart cooldown reset.`,
    );
  } else {
    alert(
      LEVEL.CRITICAL,
      'supervisor',
      `Post-restart e2e probe FAILED: ${probe.detail}. Process may not be healthy. PAGE LUCAS.`,
      { reason },
    );
  }
}

// --- Main Check Cycle ---

async function runChecks() {
  try {
    // 1. Port check
    const port = checkPort();
    if (!port.healthy) {
      alert(LEVEL.WARN, 'port', port.message);
    }

    // 2. pm2 status
    const pm2 = checkPm2Status();
    if (!pm2.healthy) {
      alert(
        LEVEL.CRITICAL,
        'pm2',
        pm2.message || `pm2 status: ${pm2.status}`,
        { status: pm2.status, restarts: pm2.restartCount },
      );
    }

    // 3. Restart spike detection
    if (pm2.restartCount !== undefined) {
      const now = Date.now();
      if (lastRestartCount !== null && pm2.restartCount > lastRestartCount) {
        restartHistory.push({
          ts: now,
          delta: pm2.restartCount - lastRestartCount,
        });
      }
      lastRestartCount = pm2.restartCount;
      const windowStart = now - RESTART_SPIKE_WINDOW_MIN * 60 * 1000;
      restartHistory = restartHistory.filter((r) => r.ts > windowStart);
      const totalRestarts = restartHistory.reduce(
        (sum, r) => sum + r.delta,
        0,
      );
      if (totalRestarts >= RESTART_SPIKE_THRESHOLD) {
        alert(
          LEVEL.CRITICAL,
          'restart-spike',
          `${totalRestarts} restarts in last ${RESTART_SPIKE_WINDOW_MIN} min`,
          { totalRestarts },
        );
      }
    }

    // 4. git-integrity (drift detection) — never throws by contract.
    checkGitIntegrity();

    // 5. Check for supervisor signal written by neutered (a)-class exit paths.
    // These are processes that signalled they need a restart but did not exit
    // cleanly enough for pm2 to handle. The signal file is cleared after reading.
    const SUPERVISOR_SIGNAL_PATH = path.join(DATA_DIR, 'supervisor-signal.json');
    try {
      if (fs.existsSync(SUPERVISOR_SIGNAL_PATH)) {
        const sigRaw = fs.readFileSync(SUPERVISOR_SIGNAL_PATH, 'utf-8');
        const sig = JSON.parse(sigRaw);
        const sigAge = Date.now() - sig.ts;
        // Only act on fresh signals (< 5 min old).
        if (sigAge < 5 * 60_000) {
          // FIX 2 (MF2): WhatsApp logout / QR-required are HUMAN-only conditions.
          // A restart cannot re-authenticate WhatsApp, so restarting just loops.
          // PAGE Lucas and clear the signal, but do NOT issue a supervised restart.
          if (isPageOnlyReason(sig.reason)) {
            alert(LEVEL.CRITICAL, 'supervisor', `WhatsApp needs human re-auth (reason: ${sig.reason}) — scan QR / re-login. NOT auto-restarting (a restart cannot fix auth). PAGE LUCAS.`, {
              signalReason: sig.reason,
              signalTs: sig.ts,
              sigAgeMs: sigAge,
            });
            // Clear the signal so it does not re-trigger; the re-auth lock
            // (written by whatsapp.ts) is what gates the client backoff.
            try { fs.unlinkSync(SUPERVISOR_SIGNAL_PATH); } catch (_e) { /* ok */ }
          } else {
            alert(LEVEL.WARN, 'supervisor', `Neutered exit signal received (reason: ${sig.reason}). Issuing supervised restart.`, {
              signalReason: sig.reason,
              signalTs: sig.ts,
              sigAgeMs: sigAge,
            });
            // Clear the signal before restarting to prevent re-triggering.
            try { fs.unlinkSync(SUPERVISOR_SIGNAL_PATH); } catch (_e) { /* ok */ }
            await supervisedRestart('neutered-exit-' + sig.reason);
          }
        } else {
          // Stale signal — clear it silently.
          try { fs.unlinkSync(SUPERVISOR_SIGNAL_PATH); } catch (_e) { /* ok */ }
        }
      }
    } catch (_e) {
      // Signal file unreadable — ignore.
    }

    // 6. Queue-state / supervisor logic.
    // Skipped during deploys to avoid restarting mid-deploy.
    if (!fs.existsSync(DEPLOY_LOCK_PATH)) {
      const qs = readQueueState();
      const classification = classifyQueueState(qs);
      const now = Date.now();

      // D2: Tick-stall = genuine event-loop hang. AUTO-RESTART (no page).
      // A legitimately busy process (long panel, slow build) keeps ticking
      // and is never classified as 'hung'.
      if (classification === 'hung') {
        alert(LEVEL.WARN, 'supervisor', 'Tick-stall detected: event loop appears hung. Issuing supervised restart.', {
          activeCount: qs.activeCount,
          tick_ts: qs.tick_ts,
          ageMs: now - qs.tick_ts,
          thresholdMs: TICK_STALE_THRESHOLD_MS,
        });
        await supervisedRestart('tick-stall');
      }

      // D2: 90-min backstop — oldest active run exceeded hard limit.
      // PAGE Lucas; do NOT auto-restart (something unusual is happening).
      if (qs && qs.activeCount > 0 && qs.oldestActiveStartedAt !== null) {
        const runAge = now - qs.oldestActiveStartedAt;
        if (runAge > OLDEST_ACTIVE_BACKSTOP_MS) {
          // Dedup: re-page at most once per backstop window.
          if (now - lastBackstopPageAt > OLDEST_ACTIVE_BACKSTOP_MS) {
            lastBackstopPageAt = now;
            alert(
              LEVEL.CRITICAL,
              'supervisor',
              `90-min backstop breached: oldest active run has been running ${Math.round(runAge / 60000)} min. PAGE LUCAS.`,
              {
                activeCount: qs.activeCount,
                oldestActiveStartedAt: qs.oldestActiveStartedAt,
                runAgeMs: runAge,
                backstopMs: OLDEST_ACTIVE_BACKSTOP_MS,
              },
            );
          }
        }
      }

      // D1: Zero-successful-runs alarm.
      // The 05-31 class: nanoclaw alive, heartbeat fresh, but every spawn
      // fails silently. Heartbeat staleness does NOT catch this — only an
      // explicit success counter does.
      // Fires when: nanoclaw is online AND has been up long enough to have
      // completed work AND has active containers running AND has had no
      // successful completion in the alarm window.
      // MF4 fix: active-work is evaluated over the WINDOW via qs.lastActiveAt,
      // not the instantaneous activeCount, so a retry-backoff gap (5-80s) can
      // no longer let a 60s poll land in an idle gap and miss a dead system.
      const d1 = evaluateD1Alarm({
        pm2Healthy: pm2.healthy,
        qs,
        windowMs: ZERO_SUCCESS_ALARM_WINDOW_MS,
        pm2UptimeMs: pm2.uptime,
        now,
      });
      if (d1.fire) {
        // Dedup: fire at most once per alarm window.
        if (now - lastZeroSuccessAlarmAt > ZERO_SUCCESS_ALARM_WINDOW_MS) {
          lastZeroSuccessAlarmAt = now;
          alert(
            LEVEL.CRITICAL,
            'supervisor',
            `D1 alarm: zero successful container completions in ${Math.round(ZERO_SUCCESS_ALARM_WINDOW_MS / 60000)} min window. PAGE LUCAS. This is the 05-31 class (parent healthy, spawn failing).`,
            {
              lastSuccessAt: qs && qs.lastSuccessAt,
              activeCount: qs && qs.activeCount,
              lastActiveAt: qs && qs.lastActiveAt,
              windowMs: ZERO_SUCCESS_ALARM_WINDOW_MS,
            },
          );
        }
      }
    }

    // Reset self-failure counter on a clean cycle.
    if (selfFailures > 0) {
      selfFailures = 0;
      currentInterval = CHECK_INTERVAL_MS;
      alert(LEVEL.INFO, 'self', 'Watchdog recovered, resuming normal interval');
    }
  } catch (e) {
    selfFailures++;
    alert(
      LEVEL.WARN,
      'self',
      `Check cycle failed (${selfFailures}/${MAX_SELF_FAILURES}): ${e.message}`,
    );
    if (selfFailures >= MAX_SELF_FAILURES) {
      currentInterval = DEGRADED_INTERVAL_MS;
      alert(
        LEVEL.CRITICAL,
        'self',
        `Watchdog degraded: ${selfFailures} consecutive failures. Interval now ${DEGRADED_INTERVAL_MS / 1000}s`,
      );
    }
  }
  setTimeout(runChecks, currentInterval);
}

// --- Startup ---
alert(
  LEVEL.INFO,
  'lifecycle',
  'Watchdog v2 started (supervisor mode: monitor + bounded restart authority)',
);
console.log('Watchdog v2 started. Alerts -> ' + ALERT_LOG);
setTimeout(runChecks, 5000);
