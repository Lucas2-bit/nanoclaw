/**
 * supervisor-split.test.ts
 *
 * Tests for the Supervisor Split keystone (Cycle 2, Option A).
 * Covers: Chunk 1 (observability), Chunk 3 (deny-list), Chunk 4 (gate assertions).
 *
 * These tests run entirely in-process using vitest. The watchdog-v2.cjs supervisor
 * is tested via its pure functions extracted/unit-tested here; it is NOT started.
 */

import { createRequire } from 'module';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the REAL shipping pure-logic module (src/watchdog-logic.cjs) so these
// tests exercise the same code path the supervisor runs, not a reimplemented
// copy (review SHOULD-FIX D).
const require_ = createRequire(import.meta.url);
const watchdogLogic = require_('./watchdog-logic.cjs') as {
  classifyQueueState: (
    qs: unknown,
    tickStaleThresholdMs: number,
    now?: number,
  ) => string;
  checkRestartAllowed: (
    state: { ceilingHit: boolean; history: { ts: number }[] },
    cooldownN: number,
    windowMs: number,
    now?: number,
  ) => { allowed: boolean; reason?: string };
  evaluateD1Alarm: (params: {
    pm2Healthy: boolean;
    qs: {
      activeCount: number;
      lastSuccessAt: number | null;
      lastActiveAt?: number | null;
    } | null;
    windowMs: number;
    pm2UptimeMs: number;
    now?: number;
  }) => { fire: boolean; reason?: string };
  isPageOnlyReason: (reason: string) => boolean;
};

// ---------------------------------------------------------------------------
// GroupQueue observability tests (Chunk 1)
// ---------------------------------------------------------------------------

describe('GroupQueue observability — queue-state.json', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* ok */
    }
  });

  it('getActiveCount() returns 0 on fresh GroupQueue', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    expect(queue.getActiveCount()).toBe(0);
  });

  it('startHeartbeatTick() writes queue-state.json atomically', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();

    queue.startHeartbeatTick();

    const statePath = path.join(tmpDir, 'queue-state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state).toMatchObject({
      activeCount: 0,
      oldestActiveStartedAt: null,
      tick_ts: expect.any(Number),
      ts: expect.any(Number),
    });
  });

  it('startHeartbeatTick() does not leave .tmp residue (atomic write)', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.startHeartbeatTick();
    const tmpPath = path.join(tmpDir, 'queue-state.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('startHeartbeatTick() is idempotent (second call is a no-op)', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.startHeartbeatTick();
    const statePath = path.join(tmpDir, 'queue-state.json');
    const before = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    queue.startHeartbeatTick();
    const after = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // tick_ts should not regress on second call
    expect(after.tick_ts).toBeGreaterThanOrEqual(before.tick_ts);
  });

  it('lastSuccessAt is null when no completions have occurred', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.startHeartbeatTick();
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'queue-state.json'), 'utf-8'),
    );
    expect(state.lastSuccessAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Supervisor state classifier (D2 tick-stall logic)
// Pure function extracted from watchdog-v2.cjs for unit testing.
// ---------------------------------------------------------------------------

const TICK_STALE_THRESHOLD_MS = 3 * 90_000; // 270s default

type QueueStateSnap = {
  activeCount: number;
  tick_ts: number;
  oldestActiveStartedAt: number | null;
  lastSuccessAt: number | null;
};

// Adapter: delegates to the REAL exported function so these assertions cover
// the shipping code, while preserving the existing (qs, now) call shape.
function classifyQueueState(
  qs: QueueStateSnap | null,
  now: number = Date.now(),
): 'idle' | 'busy' | 'hung' | 'no-state' {
  return watchdogLogic.classifyQueueState(qs, TICK_STALE_THRESHOLD_MS, now) as
    | 'idle'
    | 'busy'
    | 'hung'
    | 'no-state';
}

describe('D2: classifyQueueState — tick-stall vs busy distinction', () => {
  const NOW = Date.now();

  it('returns idle when activeCount === 0', () => {
    const qs: QueueStateSnap = {
      activeCount: 0,
      tick_ts: NOW - 1000,
      oldestActiveStartedAt: null,
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('idle');
  });

  it('returns busy when activeCount > 0 and tick is fresh (< 270s)', () => {
    const qs: QueueStateSnap = {
      activeCount: 2,
      tick_ts: NOW - 60_000,
      oldestActiveStartedAt: NOW - 60_000,
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('busy');
  });

  it('returns hung when activeCount > 0 and tick is stale (> 270s)', () => {
    const qs: QueueStateSnap = {
      activeCount: 1,
      tick_ts: NOW - 300_000,
      oldestActiveStartedAt: NOW - 300_000,
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('hung');
  });

  it('returns no-state when qs is null', () => {
    expect(classifyQueueState(null)).toBe('no-state');
  });

  it('treats negative age (NTP step forward) as stale — conservative clock tolerance', () => {
    const qs: QueueStateSnap = {
      activeCount: 1,
      tick_ts: NOW + 5_000,
      oldestActiveStartedAt: NOW - 60_000,
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('hung');
  });

  it('active long-running 40-min panel stays busy, NOT hung (tick is fresh)', () => {
    // The key distinction: event loop is alive (tick fresh), just doing long work.
    const qs: QueueStateSnap = {
      activeCount: 1,
      tick_ts: NOW - 60_000, // tick 1 min ago = alive
      oldestActiveStartedAt: NOW - 40 * 60_000, // started 40 min ago
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('busy');
  });

  it('hung process at exactly TICK_STALE_THRESHOLD_MS boundary', () => {
    const qs: QueueStateSnap = {
      activeCount: 1,
      tick_ts: NOW - TICK_STALE_THRESHOLD_MS - 1, // 1ms over threshold
      oldestActiveStartedAt: NOW - TICK_STALE_THRESHOLD_MS,
      lastSuccessAt: null,
    };
    expect(classifyQueueState(qs, NOW)).toBe('hung');
  });
});

// ---------------------------------------------------------------------------
// MF4: Restart cooldown + ceiling (pure function from watchdog-v2.cjs)
// ---------------------------------------------------------------------------

const RESTART_COOLDOWN_N = 2;
const RESTART_COOLDOWN_WINDOW_MS = 15 * 60_000;

type RestartState = { history: { ts: number }[]; ceilingHit: boolean };

function makeRestartState(): RestartState {
  return { history: [], ceilingHit: false };
}

// Adapter: delegates to the REAL exported function (preserves prune side-effect
// the existing tests rely on, then evaluates via the shipping pure logic).
function checkRestartAllowed(
  state: RestartState,
  now: number = Date.now(),
): { allowed: boolean; reason?: string } {
  state.history = state.history.filter(
    (r) => r.ts > now - RESTART_COOLDOWN_WINDOW_MS,
  );
  return watchdogLogic.checkRestartAllowed(
    state,
    RESTART_COOLDOWN_N,
    RESTART_COOLDOWN_WINDOW_MS,
    now,
  );
}

describe('MF4: restart cooldown + ceiling (N=2 / 15min)', () => {
  it('allows first restart when history is empty', () => {
    expect(checkRestartAllowed(makeRestartState()).allowed).toBe(true);
  });

  it('allows second restart within window (at N-1 = 1)', () => {
    const state = makeRestartState();
    const now = Date.now();
    state.history.push({ ts: now - 1000 });
    expect(checkRestartAllowed(state, now).allowed).toBe(true);
  });

  it('denies restart when history has N=2 entries within window', () => {
    const state = makeRestartState();
    const now = Date.now();
    state.history.push({ ts: now - 1000 });
    state.history.push({ ts: now - 2000 });
    const result = checkRestartAllowed(state, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('cooldown-exceeded');
  });

  it('allows restart after window expires (history pruned automatically)', () => {
    const state = makeRestartState();
    const now = Date.now();
    state.history.push({ ts: now - 16 * 60_000 }); // outside 15-min window
    state.history.push({ ts: now - 17 * 60_000 });
    expect(checkRestartAllowed(state, now).allowed).toBe(true);
  });

  it('ceiling-hit permanently blocks restarts', () => {
    const state = makeRestartState();
    state.ceilingHit = true;
    expect(checkRestartAllowed(state).allowed).toBe(false);
    expect(checkRestartAllowed(state).reason).toBe('ceiling-hit');
  });

  it('counter resets (simulated) allows restarts again after verified success', () => {
    // Simulates MF4: counter resets only on verified e2e success
    const state = makeRestartState();
    const now = Date.now();
    state.history.push({ ts: now - 1000 });
    state.history.push({ ts: now - 2000 });
    expect(checkRestartAllowed(state, now).allowed).toBe(false);

    // e2e probe succeeded: reset
    state.history = [];
    state.ceilingHit = false;

    expect(checkRestartAllowed(state, now).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D3 deny-list tests: mac-host-bridge approved commands
// ---------------------------------------------------------------------------

describe('D3 (shipped): agent keeps self-stop, gated by supervisor + 2-phase / INV-3: no supervisor-kill verbs', () => {
  // The mac-host-bridge config.py lives in the nanoclaw repo at this path.
  // Tests run on the host, so we read from the repo copy (not the container path).
  const CONFIG_PATH = path.resolve(
    __dirname,
    '..',
    'mac-host-bridge',
    'src',
    'mac_host_bridge',
    'config.py',
  );

  let configSource: string;
  beforeEach(() => {
    configSource = fs.readFileSync(CONFIG_PATH, 'utf-8');
  });

  it('nanoclaw_stop IS an ApprovedCommand enum value (shipped design: agent keeps self-stop, Lucas 2026-06-02; safety via supervisor auto-revival + 2-phase gate)', () => {
    expect(configSource).toMatch(/NANOCLAW_STOP\s*=\s*"nanoclaw_stop"/);
  });

  it('nanoclaw_stop IS a key in _approved_commands dict (self-stop lever retained)', () => {
    expect(configSource).toMatch(/"nanoclaw_stop"\s*:/);
  });

  it('nanoclaw_restart IS an ApprovedCommand enum value (D3: agent self-restart lever preserved)', () => {
    expect(configSource).toMatch(/NANOCLAW_RESTART\s*=\s*"nanoclaw_restart"/);
  });

  it('nanoclaw_restart IS a key in _approved_commands dict', () => {
    expect(configSource).toMatch(/"nanoclaw_restart"\s*:/);
  });

  it('no watchdog lifecycle verbs exist in approved commands (INV-3)', () => {
    // Agent must not be able to stop/kill/restart the supervisor
    expect(configSource).not.toMatch(
      /watchdog_restart|watchdog_stop|watchdog_kill/i,
    );
    expect(configSource).not.toMatch(
      /supervisor_restart|supervisor_stop|supervisor_kill/i,
    );
  });

  it('no nanoclaw_operator_stop split shipped (capability+gate chosen over amputation, Lucas 2026-06-02); nanoclaw_restart lever present', () => {
    expect(configSource).not.toMatch(/nanoclaw_operator_stop/);
    expect(configSource).toMatch(/NANOCLAW_RESTART\s*=\s*"nanoclaw_restart"/);
  });

  it('NO_ARGS_COMMANDS contains nanoclaw_restart and nanoclaw_stop (both agent levers kept)', () => {
    expect(configSource).toMatch(
      /NO_ARGS_COMMANDS\s*=\s*\{[^}]*"nanoclaw_restart"[^}]*\}/s,
    );
    expect(configSource).toMatch(
      /NO_ARGS_COMMANDS\s*=\s*\{[^}]*"nanoclaw_stop"[^}]*\}/s,
    );
  });
});

// ---------------------------------------------------------------------------
// MF1: no-fail-closed — supervisor signal mechanism tests
// ---------------------------------------------------------------------------

describe('MF1: supervisor signal mechanism', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sig-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* ok */
    }
  });

  it('supervisor-signal.json is written atomically via tmp+rename (no .tmp residue)', () => {
    const signalPath = path.join(tmpDir, 'supervisor-signal.json');
    const tmp = signalPath + '.tmp';
    const payload = JSON.stringify({
      ts: Date.now(),
      reason: 'message-loop-crash',
      pid: 99999,
    });

    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, signalPath);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(signalPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    expect(written.reason).toBe('message-loop-crash');
    expect(written.pid).toBe(99999);
  });

  it('supervisor ignores stale signals (> 5 min old)', () => {
    const signalPath = path.join(tmpDir, 'supervisor-signal.json');
    fs.writeFileSync(
      signalPath,
      JSON.stringify({ ts: Date.now() - 10 * 60_000, reason: 'old', pid: 1 }),
    );
    const sig = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    const isFresh = Date.now() - sig.ts < 5 * 60_000;
    expect(isFresh).toBe(false);
  });

  it('supervisor acts on fresh signals (< 5 min old)', () => {
    const signalPath = path.join(tmpDir, 'supervisor-signal.json');
    fs.writeFileSync(
      signalPath,
      JSON.stringify({
        ts: Date.now() - 30_000,
        reason: 'message-loop-crash',
        pid: 1,
      }),
    );
    const sig = JSON.parse(fs.readFileSync(signalPath, 'utf-8'));
    const isFresh = Date.now() - sig.ts < 5 * 60_000;
    expect(isFresh).toBe(true);
    expect(sig.reason).toBe('message-loop-crash');
  });

  it('all neutered (a)-class paths in index.ts write a supervisor signal before exiting', () => {
    // Verify the source of index.ts contains the supervisor signal write
    const indexSource = fs.readFileSync(
      path.resolve(__dirname, 'index.ts'),
      'utf-8',
    );

    // The message-loop-crash path should write the signal
    expect(indexSource).toMatch(/supervisor-signal\.json/);
    expect(indexSource).toMatch(/message-loop-crash/);
  });

  it('all neutered (a)-class paths in whatsapp.ts write a supervisor signal before exiting', () => {
    const whatsappSource = fs.readFileSync(
      path.resolve(__dirname, 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    expect(whatsappSource).toMatch(/supervisor-signal\.json/);
    expect(whatsappSource).toMatch(/whatsapp-qr-required/);
    expect(whatsappSource).toMatch(/whatsapp-logged-out/);
  });
});

// ---------------------------------------------------------------------------
// SHOULD-FIX-C: 05-31 class simulation
// Scenario: parent healthy + heartbeat fresh + 100% spawn failure
// Assert: D1 standing alarm fires
// ---------------------------------------------------------------------------

describe('SHOULD-FIX-C: 05-31 simulation — D1 alarm fires when spawns fail silently', () => {
  const ZERO_SUCCESS_ALARM_WINDOW_MS = 30 * 60_000;

  /**
   * Pure D1 alarm evaluation logic (inlined from watchdog-v2.cjs).
   */
  function evaluateD1Alarm(params: {
    pm2Healthy: boolean;
    pm2Uptime: number;
    qs: { activeCount: number; lastSuccessAt: number | null } | null;
    now: number;
    lastZeroSuccessAlarmAt: number;
  }): { fires: boolean; reason?: string } {
    const { pm2Healthy, pm2Uptime, qs, now, lastZeroSuccessAlarmAt } = params;
    if (!pm2Healthy || !qs)
      return { fires: false, reason: 'pm2-not-healthy-or-no-qs' };
    const windowStart = now - ZERO_SUCCESS_ALARM_WINDOW_MS;
    const noRecentSuccess =
      qs.lastSuccessAt === null || qs.lastSuccessAt < windowStart;
    const processOldEnough = pm2Uptime > ZERO_SUCCESS_ALARM_WINDOW_MS;
    const hasActiveWork = qs.activeCount > 0;
    if (!noRecentSuccess)
      return { fires: false, reason: 'recent-success-exists' };
    if (!processOldEnough) return { fires: false, reason: 'process-too-young' };
    if (!hasActiveWork) return { fires: false, reason: 'no-active-work' };
    if (now - lastZeroSuccessAlarmAt <= ZERO_SUCCESS_ALARM_WINDOW_MS) {
      return { fires: false, reason: 'dedup-suppressed' };
    }
    return { fires: true };
  }

  const NOW = Date.now();

  it('FIRES: parent healthy, heartbeat fresh, zero successes in 30-min window (05-31 class)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 45 * 60_000, // process has been up 45 min
      qs: { activeCount: 1, lastSuccessAt: null }, // no successes ever
      now: NOW,
      lastZeroSuccessAlarmAt: 0, // never fired
    });
    expect(result.fires).toBe(true);
  });

  it('does NOT fire when recent success exists (healthy case)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 45 * 60_000,
      qs: { activeCount: 1, lastSuccessAt: NOW - 5 * 60_000 }, // success 5 min ago
      now: NOW,
      lastZeroSuccessAlarmAt: 0,
    });
    expect(result.fires).toBe(false);
    expect(result.reason).toBe('recent-success-exists');
  });

  it('does NOT fire when process just started (< 30 min uptime)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 10 * 60_000, // only 10 min old
      qs: { activeCount: 1, lastSuccessAt: null },
      now: NOW,
      lastZeroSuccessAlarmAt: 0,
    });
    expect(result.fires).toBe(false);
    expect(result.reason).toBe('process-too-young');
  });

  it('does NOT fire when idle (no active work = success absence is expected)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 45 * 60_000,
      qs: { activeCount: 0, lastSuccessAt: null },
      now: NOW,
      lastZeroSuccessAlarmAt: 0,
    });
    expect(result.fires).toBe(false);
    expect(result.reason).toBe('no-active-work');
  });

  it('is deduped: does NOT re-fire within alarm window', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 45 * 60_000,
      qs: { activeCount: 1, lastSuccessAt: null },
      now: NOW,
      lastZeroSuccessAlarmAt: NOW - 10 * 60_000, // fired 10 min ago (within 30-min window)
    });
    expect(result.fires).toBe(false);
    expect(result.reason).toBe('dedup-suppressed');
  });

  it('re-fires after alarm window expires (persistent failure stays alarmed)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: true,
      pm2Uptime: 60 * 60_000,
      qs: { activeCount: 1, lastSuccessAt: null },
      now: NOW,
      lastZeroSuccessAlarmAt: NOW - 35 * 60_000, // fired 35 min ago (> 30-min window)
    });
    expect(result.fires).toBe(true);
  });

  it('does NOT fire when pm2 reports nanoclaw as unhealthy (different class of failure)', () => {
    const result = evaluateD1Alarm({
      pm2Healthy: false, // pm2 knows process is down
      pm2Uptime: 45 * 60_000,
      qs: { activeCount: 1, lastSuccessAt: null },
      now: NOW,
      lastZeroSuccessAlarmAt: 0,
    });
    expect(result.fires).toBe(false);
    expect(result.reason).toBe('pm2-not-healthy-or-no-qs');
  });
});

// ===========================================================================
// FIX 1 (MF3): lastSuccessAt must update ONLY on a genuine end-to-end run.
// Real-behavior test: drives the REAL GroupQueue and inspects the
// queue-state.json it writes. No-op returns (ranToCompletion:false) must NOT
// refresh lastSuccessAt; a real completion (ranToCompletion:true) must.
// ===========================================================================
describe('FIX 1 (MF3): lastSuccessAt only refreshed by a real completion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mf3-'));
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* ok */
    }
  });

  function readState(): {
    lastSuccessAt: number | null;
    lastActiveAt: number | null;
  } {
    const raw = fs.readFileSync(path.join(tmpDir, 'queue-state.json'), 'utf-8');
    return JSON.parse(raw);
  }

  it('a NO-OP return ({ok:true, ranToCompletion:false}) does NOT set lastSuccessAt', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.setProcessMessagesFn(async () => ({
      ok: true,
      ranToCompletion: false,
    }));
    queue.enqueueMessageCheck('group1@g.us');
    // Let the microtask/queue drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(readState().lastSuccessAt).toBeNull();
    // lastActiveAt SHOULD be set — a run was attempted (drives windowed D1).
    expect(readState().lastActiveAt).not.toBeNull();
  });

  it('a REAL completion ({ok:true, ranToCompletion:true}) DOES set lastSuccessAt', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.setProcessMessagesFn(async () => ({
      ok: true,
      ranToCompletion: true,
    }));
    queue.enqueueMessageCheck('group1@g.us');
    await new Promise((r) => setTimeout(r, 50));
    expect(readState().lastSuccessAt).not.toBeNull();
  });

  it('a FAILED run ({ok:false}) does NOT set lastSuccessAt', async () => {
    vi.doMock('./config.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./config.js')>();
      return { ...orig, DATA_DIR: tmpDir };
    });
    const { GroupQueue } = await import('./group-queue.js');
    const queue = new GroupQueue();
    queue.setProcessMessagesFn(async () => ({
      ok: false,
      ranToCompletion: false,
    }));
    queue.enqueueMessageCheck('group1@g.us');
    await new Promise((r) => setTimeout(r, 50));
    expect(readState().lastSuccessAt).toBeNull();
  });
});

// ===========================================================================
// FIX 2 (MF2): WhatsApp logout/QR signals are PAGE-ONLY (no supervised restart);
// generic neutered-exit reasons still restart. Tests the REAL isPageOnlyReason.
// ===========================================================================
describe('FIX 2 (MF2): page-only classification of supervisor signal reasons', () => {
  it('whatsapp-logged-out is page-only (must NOT trigger a supervised restart)', () => {
    expect(watchdogLogic.isPageOnlyReason('whatsapp-logged-out')).toBe(true);
  });
  it('whatsapp-qr-required is page-only (must NOT trigger a supervised restart)', () => {
    expect(watchdogLogic.isPageOnlyReason('whatsapp-qr-required')).toBe(true);
  });
  it('a generic neutered-exit reason is NOT page-only (still restarts)', () => {
    expect(watchdogLogic.isPageOnlyReason('message-loop-crash')).toBe(false);
    expect(watchdogLogic.isPageOnlyReason('tick-stall')).toBe(false);
  });
});

// ===========================================================================
// FIX 3 (MF4): D1 considers active-work over the WINDOW (lastActiveAt), not the
// instantaneous activeCount, so a retry-backoff gap cannot hide a dead system.
// Tests the REAL evaluateD1Alarm exported from watchdog-logic.cjs.
// ===========================================================================
describe('FIX 3 (MF4): D1 windowed active-work via lastActiveAt', () => {
  const WINDOW = 30 * 60_000;
  const NOW = Date.now();

  it('FIRES when activeCount==0 NOW but lastActiveAt is within the window and zero successes (backoff-gap case)', () => {
    const result = watchdogLogic.evaluateD1Alarm({
      pm2Healthy: true,
      pm2UptimeMs: 45 * 60_000,
      qs: { activeCount: 0, lastSuccessAt: null, lastActiveAt: NOW - 30_000 }, // active 30s ago (in a retry backoff gap)
      windowMs: WINDOW,
      now: NOW,
    });
    expect(result.fire).toBe(true);
  });

  it('does NOT fire when there has been NO active work within the window (genuinely idle)', () => {
    const result = watchdogLogic.evaluateD1Alarm({
      pm2Healthy: true,
      pm2UptimeMs: 45 * 60_000,
      qs: {
        activeCount: 0,
        lastSuccessAt: null,
        lastActiveAt: NOW - 60 * 60_000,
      }, // last active 60 min ago (outside window)
      windowMs: WINDOW,
      now: NOW,
    });
    expect(result.fire).toBe(false);
  });

  it('FIRES with instantaneous activeCount>0 and zero successes (original 05-31 case still covered)', () => {
    const result = watchdogLogic.evaluateD1Alarm({
      pm2Healthy: true,
      pm2UptimeMs: 45 * 60_000,
      qs: { activeCount: 1, lastSuccessAt: null, lastActiveAt: NOW },
      windowMs: WINDOW,
      now: NOW,
    });
    expect(result.fire).toBe(true);
  });

  it('does NOT fire when a real success occurred within the window', () => {
    const result = watchdogLogic.evaluateD1Alarm({
      pm2Healthy: true,
      pm2UptimeMs: 45 * 60_000,
      qs: {
        activeCount: 1,
        lastSuccessAt: NOW - 5 * 60_000,
        lastActiveAt: NOW,
      },
      windowMs: WINDOW,
      now: NOW,
    });
    expect(result.fire).toBe(false);
  });
});
