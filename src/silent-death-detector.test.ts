import fs from 'fs';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use a real per-process tmpdir so the wiring test below can read files
// written by writeAlertFile, and so concurrent vitest workers don't share
// a fixed path. The path is surfaced via process.env because vi.mock is
// hoisted above all top-level statements.
vi.mock('./config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const dir = fsMod.mkdtempSync(
    pathMod.join(osMod.tmpdir(), 'nanoclaw-silent-death-'),
  );
  process.env.NANOCLAW_SILENT_DEATH_TEST_TMP = dir;
  return { DATA_DIR: dir };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildSilentDeathAlertText,
  createDetector,
  recordPromptStarted,
  startSilentDeathDetector,
} from './silent-death-detector.js';
import { screenOutbound } from './safety/allergens.js';

const WINDOW_MS = 15 * 60 * 1000;

function makeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('silent-death-detector evaluate()', () => {
  it('alarms when prompts>=3 and successes==0 in window', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    d.recordPromptStarted();
    d.recordPromptStarted();
    d.recordPromptStarted();
    const r = d.evaluate();
    expect(r.alarm).toBe(true);
    expect(r.kind).toBe('silent-death');
    expect(r.prompts).toBe(3);
    expect(r.successes).toBe(0);
  });

  it('does not alarm when prompts>=3 and successes>=1', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    d.recordPromptStarted();
    d.recordPromptStarted();
    d.recordPromptStarted();
    d.recordContainerSuccess();
    const r = d.evaluate();
    expect(r.alarm).toBe(false);
    expect(r.kind).toBe(null);
    expect(r.successes).toBe(1);
  });

  it('does not alarm when prompts are below the threshold', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    d.recordPromptStarted();
    d.recordPromptStarted();
    const r = d.evaluate();
    expect(r.alarm).toBe(false);
    expect(r.kind).toBe(null);
    expect(r.prompts).toBe(2);
  });

  it('alarms on >=3 SAFETY_BLOCK-missing observations via observeError', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    // Mix of host-side and container-side fail-closed phrasings — both must match.
    d.observeError(
      'SAFETY-CRITICAL: SAFETY_BLOCK is missing or empty; refusing to spawn agent container',
    );
    d.observeError(
      'Container exited with code 1: ...SAFETY_BLOCK missing; refusing to invoke model',
    );
    d.observeError('refusing to invoke model: SAFETY_BLOCK empty');
    const r = d.evaluate();
    expect(r.alarm).toBe(true);
    expect(r.kind).toBe('safety-block-loop');
    expect(r.safetyBlockMisses).toBe(3);
  });

  it('de-dupes: alarm fires once per window, not on every evaluate()', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    d.recordPromptStarted();
    d.recordPromptStarted();
    d.recordPromptStarted();

    const first = d.evaluate();
    expect(first.alarm).toBe(true);

    // Same condition, still inside window: no re-alarm
    const second = d.evaluate();
    expect(second.alarm).toBe(false);
    expect(second.kind).toBe('silent-death'); // condition still detected, just deduped

    // Advance past dedupe window, add more prompts so condition still holds,
    // and confirm a fresh alarm fires.
    clock.advance(WINDOW_MS + 1);
    d.recordPromptStarted();
    d.recordPromptStarted();
    d.recordPromptStarted();
    const third = d.evaluate();
    expect(third.alarm).toBe(true);
  });

  it('observeError ignores non-matching error strings', () => {
    const clock = makeClock();
    const d = createDetector({ windowMs: WINDOW_MS, now: clock.now });
    d.observeError('Container exited with code 1: ECONNREFUSED');
    d.observeError(undefined);
    d.observeError('totally unrelated stack trace');
    const r = d.evaluate();
    expect(r.safetyBlockMisses).toBe(0);
    expect(r.alarm).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Lock: the outbound alert text MUST pass the real allergen screener.
// Regression for the lock comment on buildSilentDeathAlertText. If a future
// change introduces an allergen + affirmative token into the alert, this test
// fails before it can reach production — where the screener would page Lucas
// (current ALERT-AND-PASS) or silently drop the alert (historical regime).
// ----------------------------------------------------------------------------
describe('silent-death-detector outbound alert text (allergen-screener lock)', () => {
  it("real screenOutbound returns 'pass' for the silent-death variant", () => {
    const text = buildSilentDeathAlertText(
      'silent-death',
      '3 prompts, 0 successful runs in 15m',
    );
    const verdict = screenOutbound(text);
    expect(verdict.action).toBe('pass');
  });

  it("real screenOutbound returns 'pass' for the safety-block-loop variant", () => {
    const text = buildSilentDeathAlertText(
      'safety-block-loop',
      '5 SAFETY_BLOCK-missing events in 15m',
    );
    const verdict = screenOutbound(text);
    expect(verdict.action).toBe('pass');
  });

  it("real screenOutbound returns 'pass' even with edge-case reason strings", () => {
    // Defensive cases: reasons that include numbers and the literal phrase
    // SAFETY_BLOCK still must not trip the screener.
    const cases = [
      buildSilentDeathAlertText('silent-death', '99 prompts, 0 successful runs in 60m'),
      buildSilentDeathAlertText('safety-block-loop', '12 SAFETY_BLOCK-missing events in 5m'),
    ];
    for (const t of cases) {
      expect(screenOutbound(t).action).toBe('pass');
    }
  });
});

// ----------------------------------------------------------------------------
// Wiring: startSilentDeathDetector — verify the scheduled tick really
// invokes notifyMain AND writes an alert file when the singleton detector
// hits the silent-death threshold. The pure-logic tests above use
// createDetector, so this is the first test exercising the singleton path.
// Uses fake timers (vitest's clock substitution = injectable clock).
// ----------------------------------------------------------------------------
describe('startSilentDeathDetector wiring', () => {
  const ALERTS_DIR = path.join(
    process.env.NANOCLAW_SILENT_DEATH_TEST_TMP || '',
    'alerts',
  );

  beforeEach(() => {
    // Start fake time far enough past 0 that the detector's initial
    // dedupe check (now - lastAlarmAt < windowMs, lastAlarmAt=0) reports
    // "not in dedupe". Default windowMs = 15min, so use 16min.
    vi.useFakeTimers({ now: 16 * 60 * 1000 });
    if (fs.existsSync(ALERTS_DIR)) {
      for (const f of fs.readdirSync(ALERTS_DIR)) {
        const full = path.join(ALERTS_DIR, f);
        if (fs.statSync(full).isFile()) fs.unlinkSync(full);
      }
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on silent-death threshold: tick invokes notifyMain and writes an alert file', async () => {
    const notifyMain = vi.fn(async (_text: string) => {});

    // 3 prompts, 0 successes → singleton evaluate() returns alarm=true.
    recordPromptStarted();
    recordPromptStarted();
    recordPromptStarted();

    const pollMs = 1_000;
    startSilentDeathDetector(notifyMain, pollMs);

    // First tick is deferred by pollMs. Advance and let microtasks flush.
    await vi.advanceTimersByTimeAsync(pollMs);

    expect(notifyMain).toHaveBeenCalledTimes(1);
    const msg = notifyMain.mock.calls[0][0];
    expect(msg).toContain('SILENT DEATH DETECTED');
    expect(msg.startsWith('[ops] ')).toBe(true);

    expect(fs.existsSync(ALERTS_DIR)).toBe(true);
    const files = fs.readdirSync(ALERTS_DIR);
    const silentDeathFiles = files.filter((f) =>
      f.startsWith('silent-death-'),
    );
    expect(silentDeathFiles.length).toBeGreaterThanOrEqual(1);
    const body = fs.readFileSync(
      path.join(ALERTS_DIR, silentDeathFiles[0]),
      'utf-8',
    );
    expect(body).toContain('SILENT DEATH DETECTED');
    expect(body).toContain('prompts=3');
    expect(body).toContain('successes=0');
  });
});
