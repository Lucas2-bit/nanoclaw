// watchdog-v2.cjs
// RESPONSIBILITIES: Monitor + Alert ONLY. Never restarts anything.
// Managed by pm2 as a separate app named 'watchdog'

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Configuration ---
const CHECK_INTERVAL_MS = 60_000;
const DEGRADED_INTERVAL_MS = 300_000;
const PORT = 3001;
const ALERT_LOG = path.join(__dirname, '..', 'logs', 'watchdog-alerts.log');
const ALERT_PICKUP_DIR = path.join(__dirname, '..', 'logs', 'alerts');
const MAX_SELF_FAILURES = 3;
const RESTART_SPIKE_THRESHOLD = 5;
const RESTART_SPIKE_WINDOW_MIN = 10;

// Git-integrity check is loaded from compiled dist/. If dist isn't built yet
// (fresh checkout, mid-deploy) we emit one advisory and continue — the rest
// of the watchdog must keep running.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const DEPLOY_LOCK_PATH = path.join(DATA_DIR, '.deploy.lock');
const INTEGRITY_ALERT_COOLDOWN_MS = 30 * 60_000;

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
// ok<->drift or (b) the same drift persisting for >= 30 min. Key includes
// reasonCodes + build sha + head sha so any meaningful change re-fires.
let lastIntegrityState = { ok: null, key: null, lastAlertAt: 0 };
let integrityModuleMissingAlerted = false;

// --- Alert Levels ---
const LEVEL = { INFO: 'INFO', WARN: 'WARN', CRITICAL: 'CRITICAL' };

function alert(level, component, message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...data
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
  } catch {
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
  if (integrityModule && typeof integrityModule.formatIntegrityMessage === 'function') {
    try {
      return integrityModule.formatIntegrityMessage(result);
    } catch {
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

function checkPm2Status() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 10000, stdio: 'pipe' }).toString();
    const procs = JSON.parse(raw);
    const nc = procs.find(p => p.name === 'nanoclaw');
    if (!nc) return { healthy: false, message: 'nanoclaw not found in pm2' };
    const env = nc.pm2_env || {};
    return {
      healthy: env.status === 'online',
      status: env.status,
      restarts: env.restart_time || 0,
      unstable_restarts: env.unstable_restarts || 0,
      uptime: env.pm_uptime ? Date.now() - env.pm_uptime : 0
    };
  } catch (e) {
    return { healthy: false, message: `pm2 query failed: ${e.message}` };
  }
}

// --- Main Check Cycle ---

function runChecks() {
  try {
    // 1. Port check
    const port = checkPort();
    if (!port.healthy) {
      alert(LEVEL.WARN, 'port', port.message);
    }

    // 2. pm2 status
    const pm2 = checkPm2Status();
    if (!pm2.healthy) {
      alert(LEVEL.CRITICAL, 'pm2', pm2.message || `pm2 status: ${pm2.status}`, {
        status: pm2.status, restarts: pm2.restarts
      });
    }

    // 3. Restart spike detection
    if (pm2.restarts !== undefined) {
      const now = Date.now();
      if (lastRestartCount !== null && pm2.restarts > lastRestartCount) {
        restartHistory.push({ ts: now, delta: pm2.restarts - lastRestartCount });
      }
      lastRestartCount = pm2.restarts;
      const windowStart = now - (RESTART_SPIKE_WINDOW_MIN * 60 * 1000);
      restartHistory = restartHistory.filter(r => r.ts > windowStart);
      const totalRestarts = restartHistory.reduce((sum, r) => sum + r.delta, 0);
      if (totalRestarts >= RESTART_SPIKE_THRESHOLD) {
        alert(LEVEL.CRITICAL, 'restart-spike',
          `${totalRestarts} restarts in last ${RESTART_SPIKE_WINDOW_MIN} min`,
          { totalRestarts }
        );
      }
    }

    // 4. git-integrity (drift detection) — never throws by contract.
    checkGitIntegrity();

    // Reset self-failure counter on success
    if (selfFailures > 0) {
      selfFailures = 0;
      currentInterval = CHECK_INTERVAL_MS;
      alert(LEVEL.INFO, 'self', 'Watchdog recovered, resuming normal interval');
    }
  } catch (e) {
    selfFailures++;
    alert(LEVEL.WARN, 'self', `Check cycle failed (${selfFailures}/${MAX_SELF_FAILURES}): ${e.message}`);
    if (selfFailures >= MAX_SELF_FAILURES) {
      currentInterval = DEGRADED_INTERVAL_MS;
      alert(LEVEL.CRITICAL, 'self',
        `Watchdog degraded: ${selfFailures} consecutive failures. Interval now ${DEGRADED_INTERVAL_MS / 1000}s`);
    }
  }
  setTimeout(runChecks, currentInterval);
}

// --- Startup ---
alert(LEVEL.INFO, 'lifecycle', 'Watchdog v2 started (monitor-only, no restart capability)');
console.log('Watchdog v2 started. Alerts -> ' + ALERT_LOG);
setTimeout(runChecks, 5000);
