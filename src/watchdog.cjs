#!/usr/bin/env node

/**
 * NanoClaw Watchdog - "Night Watchman" v1.0
 *
 * Persistent monitor running independently via pm2.
 * Detects and fixes known failure modes at zero API cost.
 * Uses Ollama/Gemma locally for reasoning on novel failures.
 *
 * Deploy: pm2 start ~/nanoclaw/src/watchdog.js --name watchdog
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL_MS = 60_000;
const NANOCLAW_PORT = 3001;
const PM2_PROCESS_NAME = 'nanoclaw';
const NANOCLAW_DIR = process.env.HOME + '/nanoclaw';
const SESSION_DIR = NANOCLAW_DIR + '/data/sessions';
const SESSION_SIZE_WARN_MB = 3;
const SESSION_SIZE_CRITICAL_MB = 5;
const RESTART_SPIKE_THRESHOLD = 5;
const LOG_FILE = NANOCLAW_DIR + '/logs/watchdog.log';
const OLLAMA_URL = 'http://localhost:11434';

// Live sink for nanoclaw stdout is pm2's per-process out-log, NOT
// logs/nanoclaw.log (the old file-based log that the app no longer
// writes — see checkPm2() / pm_out_log_path). Prefer the path returned
// by `pm2 jlist` at runtime so this survives a `pm2 set` log relocation.
// Fallback constant matches the default PM2_HOME layout.
const PM2_OUT_LOG_FALLBACK =
  process.env.NANOCLAW_PM2_OUT_LOG ||
  (process.env.PM2_HOME || process.env.HOME + '/.pm2') +
    '/logs/nanoclaw-out.log';

let lastRestartCount = null;
let consecutiveFailures = 0;

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${level}: ${msg}${data ? ' | ' + JSON.stringify(data) : ''}`;
  console.log(entry);
  try {
    fs.appendFileSync(LOG_FILE, entry + '\n');
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-500).join('\n'));
    }
  } catch (e) {}
}

function run(cmd, timeout = 10_000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return null; }
}

function checkPort() {
  const result = run(`lsof -ti :${NANOCLAW_PORT}`);
  if (!result) return { healthy: false, pids: [] };
  return { healthy: true, pids: result.split('\n').map(p => p.trim()).filter(Boolean) };
}

function checkPm2() {
  const raw = run('pm2 jlist');
  if (!raw) return { found: false, status: 'unknown', restarts: 0, pid: null, outLog: PM2_OUT_LOG_FALLBACK };
  try {
    const procs = JSON.parse(raw);
    const nc = procs.find(p => p.name === PM2_PROCESS_NAME);
    if (!nc) return { found: false, status: 'missing', restarts: 0, pid: null, outLog: PM2_OUT_LOG_FALLBACK };
    return {
      found: true,
      status: nc.pm2_env.status,
      restarts: nc.pm2_env.restart_time || 0,
      pid: nc.pid,
      memory: nc.monit ? nc.monit.memory : null,
      uptime: nc.pm2_env.pm_uptime ? Date.now() - nc.pm2_env.pm_uptime : null,
      outLog: nc.pm2_env.pm_out_log_path || PM2_OUT_LOG_FALLBACK
    };
  } catch (e) { return { found: false, status: 'parse_error', restarts: 0, pid: null, outLog: PM2_OUT_LOG_FALLBACK }; }
}

function checkSessionSizes() {
  const alerts = [];
  try {
    if (!fs.existsSync(SESSION_DIR)) return alerts;
    for (const session of fs.readdirSync(SESSION_DIR)) {
      const sp = path.join(SESSION_DIR, session);
      if (!fs.statSync(sp).isDirectory()) continue;
      for (const file of fs.readdirSync(sp)) {
        try {
          const sizeMB = fs.statSync(path.join(sp, file)).size / (1024 * 1024);
          if (sizeMB > SESSION_SIZE_CRITICAL_MB) alerts.push({ session, file, sizeMB: sizeMB.toFixed(1), level: 'CRITICAL' });
          else if (sizeMB > SESSION_SIZE_WARN_MB) alerts.push({ session, file, sizeMB: sizeMB.toFixed(1), level: 'WARN' });
        } catch (e) {}
      }
    }
  } catch (e) {}
  return alerts;
}

function checkCrashLoop(restarts) {
  if (lastRestartCount === null) { lastRestartCount = restarts; return { looping: false, delta: 0 }; }
  const delta = restarts - lastRestartCount;
  lastRestartCount = restarts;
  return { looping: delta >= RESTART_SPIKE_THRESHOLD, delta };
}

function killZombieOnPort() {
  log('ACTION', 'Killing zombie on port 3001');
  const pids = run(`lsof -ti :${NANOCLAW_PORT}`);
  if (pids) pids.split('\n').filter(Boolean).forEach(pid => { run(`kill -TERM ${pid.trim()}`); log('ACTION', `SIGTERM -> ${pid.trim()}`); });
}

function restartNanoclaw() {
  log('ACTION', 'Restarting NanoClaw');
  if (run(`pm2 restart ${PM2_PROCESS_NAME}`, 15_000) === null) {
    log('WARN', 'pm2 restart failed - fresh start');
    run(`pm2 start ${NANOCLAW_DIR}/dist/index.js --name ${PM2_PROCESS_NAME}`, 15_000);
  }
}

function archiveSession(name) {
  try {
    fs.renameSync(path.join(SESSION_DIR, name), path.join(SESSION_DIR, `${name}.archived-${Date.now()}`));
    log('ACTION', `Archived session: ${name}`);
  } catch (e) { log('ERROR', `Archive failed: ${name}`, { error: e.message }); }
}

async function askOllama(prompt) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3:4b', prompt, stream: false, options: { temperature: 0.1, num_predict: 200 } })
    });
    return r.ok ? (await r.json()).response : null;
  } catch (e) { return null; }
}

async function runChecks() {
  const t0 = Date.now();
  const pm2 = checkPm2();
  const port = checkPort();
  const sessions = checkSessionSizes();
  const crash = checkCrashLoop(pm2.restarts);

  if (!pm2.found) {
    log('ERROR', 'NanoClaw missing from pm2');
    if (port.healthy) { killZombieOnPort(); await new Promise(r => setTimeout(r, 5000)); }
    restartNanoclaw(); consecutiveFailures++; return;
  }

  if (pm2.status !== 'online') {
    log('ERROR', `NanoClaw ${pm2.status}`);
    if (port.healthy) { killZombieOnPort(); await new Promise(r => setTimeout(r, 5000)); }
    restartNanoclaw(); consecutiveFailures++; return;
  }

  if (crash.looping) {
    log('ERROR', `Crash loop: +${crash.delta}`, { total: pm2.restarts });
    const zombies = port.pids.filter(p => p !== String(pm2.pid));
    if (zombies.length > 0) {
      killZombieOnPort(); await new Promise(r => setTimeout(r, 5000));
    } else {
      // pm2's out-log is the only live stdout sink for nanoclaw; the old
      // logs/nanoclaw.log file is a dead artifact and tailing it returned
      // empty context to the Ollama prompt for the entire crash-loop branch.
      const logs = run(`tail -50 ${pm2.outLog}`);
      const a = await askOllama(`NanoClaw crash-looping (${crash.delta} restarts/min). No port conflict. Logs:\n${logs}\nCause? 1-2 sentences.`);
      if (a) log('OLLAMA', a);
    }
    restartNanoclaw(); consecutiveFailures++; return;
  }

  for (const s of sessions) {
    if (s.level === 'CRITICAL') { log('ERROR', `${s.session}/${s.file} ${s.sizeMB}MB - archiving`); archiveSession(s.session); }
    else log('WARN', `${s.session}/${s.file} ${s.sizeMB}MB`);
  }

  if (pm2.status === 'online' && port.healthy && !crash.looping) {
    consecutiveFailures = 0;
    log('OK', `Healthy (${Date.now() - t0}ms)`, {
      pid: pm2.pid, restarts: pm2.restarts,
      mem: pm2.memory ? Math.round(pm2.memory / 1024 / 1024) + 'MB' : '?',
      up: pm2.uptime ? Math.round(pm2.uptime / 60000) + 'min' : '?'
    });
  }

  if (consecutiveFailures >= 5) {
    log('CRITICAL', '5 failures - backing off 5min');
    await new Promise(r => setTimeout(r, 4 * 60_000));
  }
}

async function main() {
  log('INFO', '=== Watchdog v1.0 starting ===');
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (r.ok) log('INFO', `Ollama: ${((await r.json()).models || []).map(m => m.name).join(', ')}`);
  } catch (e) { log('WARN', 'Ollama unavailable'); }
  await runChecks();
  setInterval(async () => { try { await runChecks(); } catch (e) { log('ERROR', e.message); } }, CHECK_INTERVAL_MS);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
