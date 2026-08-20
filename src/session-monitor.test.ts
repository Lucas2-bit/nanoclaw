import { describe, expect, it, beforeEach } from 'vitest';
import {
  decideSessionAction,
  isAbortAllowed,
  recordAbort,
  __resetAbortState,
} from './session-monitor.js';

// Thresholds mirrored from session-monitor.ts. Kept as literals on purpose:
// if someone changes a constant, these tests should fail and force a decision
// rather than silently re-deriving and passing.
const KB = 1024;
const WARN = 300 * KB;
const CRITICAL = 600 * KB;
const HARD = 1024 * KB;
const ABORT = 2048 * KB;

const NOW = 1_700_000_000_000;
const FRESH = NOW - 60_000; // 1 min old
const STALE = NOW - 25 * 3600 * 1000; // >24h old

const decide = (
  sizeBytes: number,
  opts: Partial<{ inFlight: boolean; abortAllowed: boolean; mtimeMs: number }> = {},
) =>
  decideSessionAction({
    sizeBytes,
    mtimeMs: opts.mtimeMs ?? FRESH,
    now: NOW,
    inFlight: opts.inFlight ?? false,
    abortAllowed: opts.abortAllowed ?? true,
  });

describe('decideSessionAction', () => {
  describe('below thresholds', () => {
    it('does nothing for a small session', () => {
      expect(decide(10 * KB)).toEqual({ kind: 'none' });
    });

    it('does nothing one byte below WARN', () => {
      expect(decide(WARN - 1)).toEqual({ kind: 'none' });
    });
  });

  describe('warn zone', () => {
    it('warns at exactly WARN when fresh', () => {
      expect(decide(WARN)).toEqual({ kind: 'warn' });
    });

    it('archives a stale warn-zone session', () => {
      expect(decide(WARN, { mtimeMs: STALE })).toEqual({
        kind: 'archive',
        reason: 'stale',
      });
    });

    it('does not archive a fresh warn-zone session even when in-flight', () => {
      expect(decide(WARN, { inFlight: true })).toEqual({ kind: 'warn' });
    });
  });

  describe('critical zone', () => {
    it('archives at exactly CRITICAL when idle', () => {
      expect(decide(CRITICAL)).toEqual({ kind: 'archive', reason: 'critical' });
    });

    it('defers at CRITICAL when a run is in-flight', () => {
      expect(decide(CRITICAL, { inFlight: true })).toEqual({
        kind: 'defer',
        reason: 'critical',
      });
    });
  });

  describe('hard ceiling', () => {
    it('archives at exactly HARD when idle', () => {
      expect(decide(HARD)).toEqual({ kind: 'archive', reason: 'hard' });
    });

    it('defers at HARD when in-flight (below abort ceiling)', () => {
      expect(decide(HARD, { inFlight: true })).toEqual({
        kind: 'defer',
        reason: 'hard',
      });
    });
  });

  describe('abort ceiling', () => {
    it('aborts at exactly ABORT when in-flight and allowed', () => {
      expect(decide(ABORT, { inFlight: true })).toEqual({ kind: 'abort' });
    });

    it('aborts well past ABORT when in-flight', () => {
      // 3770 KB is the largest size actually observed deferring on this host.
      expect(decide(3770 * KB, { inFlight: true })).toEqual({ kind: 'abort' });
    });

    it('does NOT abort when idle — plain archive is enough, nothing to kill', () => {
      expect(decide(ABORT)).toEqual({ kind: 'archive', reason: 'hard' });
      expect(decide(3770 * KB)).toEqual({ kind: 'archive', reason: 'hard' });
    });

    it('falls back to defer when throttled out, never a silent no-op', () => {
      expect(decide(ABORT, { inFlight: true, abortAllowed: false })).toEqual({
        kind: 'defer',
        reason: 'hard',
      });
    });

    it('defers one byte below ABORT rather than aborting', () => {
      expect(decide(ABORT - 1, { inFlight: true })).toEqual({
        kind: 'defer',
        reason: 'hard',
      });
    });
  });

  describe('threshold ordering', () => {
    it('is monotonic: larger sizes never produce a gentler action', () => {
      const severity: Record<string, number> = {
        none: 0,
        warn: 1,
        defer: 2,
        archive: 3,
        abort: 4,
      };
      const sizes = [0, WARN, CRITICAL, HARD, ABORT, 8192 * KB];
      for (const inFlight of [false, true]) {
        const seen = sizes.map(
          (s) => severity[decide(s, { inFlight }).kind],
        );
        for (let i = 1; i < seen.length; i++) {
          expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
        }
      }
    });
  });
});

describe('abort throttling', () => {
  const COOLDOWN = 5 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const G = 'telegram_main';

  beforeEach(() => __resetAbortState());

  it('allows the first abort for a folder', () => {
    expect(isAbortAllowed(G, NOW)).toBe(true);
  });

  it('blocks a second abort inside the cooldown', () => {
    recordAbort(G, NOW);
    expect(isAbortAllowed(G, NOW + 1)).toBe(false);
    expect(isAbortAllowed(G, NOW + COOLDOWN - 1)).toBe(false);
  });

  it('allows again once the cooldown has elapsed', () => {
    recordAbort(G, NOW);
    expect(isAbortAllowed(G, NOW + COOLDOWN)).toBe(true);
  });

  it('enforces the hourly cap of 3, then blocks', () => {
    // Three aborts spaced past the cooldown so only the cap can block.
    recordAbort(G, NOW);
    recordAbort(G, NOW + COOLDOWN);
    recordAbort(G, NOW + 2 * COOLDOWN);
    // 4th attempt, cooldown satisfied, but cap reached
    expect(isAbortAllowed(G, NOW + 3 * COOLDOWN)).toBe(false);
  });

  it('lets the cap roll off after an hour', () => {
    recordAbort(G, NOW);
    recordAbort(G, NOW + COOLDOWN);
    recordAbort(G, NOW + 2 * COOLDOWN);
    expect(isAbortAllowed(G, NOW + 3 * COOLDOWN)).toBe(false);
    // Once the earliest abort ages past the hour window, capacity returns.
    expect(isAbortAllowed(G, NOW + HOUR + 1)).toBe(true);
  });

  it('throttles each folder independently', () => {
    recordAbort(G, NOW);
    expect(isAbortAllowed(G, NOW + 1)).toBe(false);
    expect(isAbortAllowed('whatsapp_main', NOW + 1)).toBe(true);
  });

  it('a throttled folder decides defer, not abort', () => {
    recordAbort(G, NOW);
    const action = decideSessionAction({
      sizeBytes: 3770 * KB,
      mtimeMs: FRESH,
      now: NOW + 1,
      inFlight: true,
      abortAllowed: isAbortAllowed(G, NOW + 1),
    });
    expect(action).toEqual({ kind: 'defer', reason: 'hard' });
  });
});
