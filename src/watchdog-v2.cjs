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

// --- State ---
let selfFailures = 0;
let currentInterval = CHECK_INTERVAL_MS;
let lastRestartCount = null;
let restartHistory = [];

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
