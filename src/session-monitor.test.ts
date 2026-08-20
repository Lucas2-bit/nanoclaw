import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  decideSessionAction,
  effectiveSessionBytes,
  isAbortAllowed,
  recordAbort,
  isCompactAllowed,
  recordCompact,
  __resetAbortState,
  __resetCompactState,
  __resetEffectiveCache,
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

/**
 * compactAllowed defaults to FALSE so the pre-existing threshold tests keep
 * exercising the warn/archive paths. Compact behaviour is asserted explicitly.
 */
const decide = (
  effectiveBytes: number,
  opts: Partial<{
    inFlight: boolean;
    abortAllowed: boolean;
    compactAllowed: boolean;
    mtimeMs: number;
  }> = {},
) =>
  decideSessionAction({
    effectiveBytes,
    mtimeMs: opts.mtimeMs ?? FRESH,
    now: NOW,
    inFlight: opts.inFlight ?? false,
    abortAllowed: opts.abortAllowed ?? true,
    compactAllowed: opts.compactAllowed ?? false,
  });

describe('decideSessionAction', () => {
  describe('below thresholds', () => {
    it('does nothing for a small session', () => {
      expect(decide(10 * KB)).toEqual({ kind: 'none' });
    });

    it('does nothing one byte below WARN', () => {
      expect(decide(WARN - 1)).toEqual({ kind: 'none' });
    });

    it('does not compact below the threshold even when allowed', () => {
      expect(decide(WARN - 1, { compactAllowed: true })).toEqual({
        kind: 'none',
      });
    });
  });

  describe('warn zone', () => {
    it('warns at exactly WARN when compaction is on cooldown', () => {
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

  describe('compact step', () => {
    it('compacts at exactly WARN when allowed', () => {
      expect(decide(WARN, { compactAllowed: true })).toEqual({
        kind: 'compact',
      });
    });

    it('compacts regardless of a run being in-flight (non-destructive)', () => {
      expect(decide(WARN, { compactAllowed: true, inFlight: true })).toEqual({
        kind: 'compact',
      });
    });

    it('stale wins over compact — summarising an unused session is pointless', () => {
      expect(decide(WARN, { compactAllowed: true, mtimeMs: STALE })).toEqual({
        kind: 'archive',
        reason: 'stale',
      });
    });

    it('falls back to warn when on cooldown, never a silent no-op', () => {
      expect(decide(WARN, { compactAllowed: false })).toEqual({ kind: 'warn' });
    });

    it('never compacts at CRITICAL or above — guards the 2026-04-29 timeout fix', () => {
      expect(decide(CRITICAL, { compactAllowed: true })).toEqual({
        kind: 'archive',
        reason: 'critical',
      });
      expect(decide(HARD, { compactAllowed: true })).toEqual({
        kind: 'archive',
        reason: 'hard',
      });
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

    it('does NOT abort when idle — plain archive is enough, nothing to kill', () => {
      expect(decide(ABORT)).toEqual({ kind: 'archive', reason: 'hard' });
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
        compact: 2,
        defer: 3,
        archive: 4,
        abort: 5,
      };
      const sizes = [0, WARN, CRITICAL, HARD, ABORT, 8192 * KB];
      for (const inFlight of [false, true]) {
        for (const compactAllowed of [false, true]) {
          const seen = sizes.map(
            (s) => severity[decide(s, { inFlight, compactAllowed }).kind],
          );
          for (let i = 1; i < seen.length; i++) {
            expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
          }
        }
      }
    });
  });
});

describe('effectiveSessionBytes', () => {
  let dir: string;

  beforeEach(() => {
    __resetEffectiveCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.join('\n'), 'utf-8');
    return p;
  };
  const sizeOf = (p: string) => fs.statSync(p).size;
  const mtimeOf = (p: string) => fs.statSync(p).mtimeMs;
  const BOUNDARY = JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
  });

  it('returns total size when the session has never compacted', () => {
    const p = write('a.jsonl', [
      JSON.stringify({ type: 'user', x: 'a'.repeat(500) }),
      JSON.stringify({ type: 'assistant', x: 'b'.repeat(500) }),
    ]);
    expect(effectiveSessionBytes(p, sizeOf(p), mtimeOf(p))).toBe(sizeOf(p));
  });

  it('returns only the bytes at/after the last compact_boundary', () => {
    const pre = Array.from({ length: 20 }, () =>
      JSON.stringify({ type: 'user', x: 'x'.repeat(500) }),
    );
    const post = [
      JSON.stringify({ type: 'assistant', x: 'y'.repeat(100) }),
      JSON.stringify({ type: 'user', x: 'z'.repeat(100) }),
    ];
    const p = write('b.jsonl', [...pre, BOUNDARY, ...post]);

    const eff = effectiveSessionBytes(p, sizeOf(p), mtimeOf(p));
    expect(eff).toBe(
      Buffer.byteLength([BOUNDARY, ...post].join('\n'), 'utf-8'),
    );
    expect(eff).toBeLessThan(sizeOf(p) / 5); // a real, large reduction
  });

  it('uses the LAST boundary when a session compacted more than once', () => {
    const filler = JSON.stringify({ type: 'user', x: 'x'.repeat(500) });
    const tail = JSON.stringify({ type: 'user', x: 'tail' });
    const p = write('c.jsonl', [
      filler,
      BOUNDARY,
      filler,
      filler,
      BOUNDARY,
      tail,
    ]);
    expect(effectiveSessionBytes(p, sizeOf(p), mtimeOf(p))).toBe(
      Buffer.byteLength([BOUNDARY, tail].join('\n'), 'utf-8'),
    );
  });

  it('caches on unchanged (size, mtime) and re-scans after growth', () => {
    const p = write('d.jsonl', [BOUNDARY, 'a']);
    const first = effectiveSessionBytes(p, sizeOf(p), mtimeOf(p));
    expect(effectiveSessionBytes(p, sizeOf(p), mtimeOf(p))).toBe(first);

    fs.appendFileSync(p, '\n' + 'q'.repeat(400));
    expect(effectiveSessionBytes(p, sizeOf(p), mtimeOf(p))).toBeGreaterThan(
      first,
    );
  });

  it('falls back to total size when the file cannot be read', () => {
    expect(effectiveSessionBytes(path.join(dir, 'nope.jsonl'), 12345, 1)).toBe(
      12345,
    );
  });

  it('a big-but-compacted session needs no action at all', () => {
    // The real-world case: 7200 KB transcript, ~21 KB live context. Judging by
    // total size would have archived it, or killed its run at the abort ceiling.
    expect(
      decideSessionAction({
        effectiveBytes: 21 * KB,
        mtimeMs: FRESH,
        now: NOW,
        inFlight: true,
        abortAllowed: true,
        compactAllowed: true,
      }),
    ).toEqual({ kind: 'none' });
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
    recordAbort(G, NOW);
    recordAbort(G, NOW + COOLDOWN);
    recordAbort(G, NOW + 2 * COOLDOWN);
    expect(isAbortAllowed(G, NOW + 3 * COOLDOWN)).toBe(false);
  });

  it('lets the cap roll off after an hour', () => {
    recordAbort(G, NOW);
    recordAbort(G, NOW + COOLDOWN);
    recordAbort(G, NOW + 2 * COOLDOWN);
    expect(isAbortAllowed(G, NOW + 3 * COOLDOWN)).toBe(false);
    expect(isAbortAllowed(G, NOW + HOUR + 1)).toBe(true);
  });

  it('throttles each folder independently', () => {
    recordAbort(G, NOW);
    expect(isAbortAllowed(G, NOW + 1)).toBe(false);
    expect(isAbortAllowed('whatsapp_main', NOW + 1)).toBe(true);
  });
});

describe('compact cooldown', () => {
  const HOUR = 60 * 60 * 1000;
  const G = 'telegram_main';

  beforeEach(() => __resetCompactState());

  it('allows the first compact', () => {
    expect(isCompactAllowed(G, NOW)).toBe(true);
  });

  it('blocks inside the 60-minute cooldown', () => {
    recordCompact(G, NOW);
    expect(isCompactAllowed(G, NOW + 1)).toBe(false);
    expect(isCompactAllowed(G, NOW + HOUR - 1)).toBe(false);
  });

  it('allows again exactly at the cooldown boundary', () => {
    recordCompact(G, NOW);
    expect(isCompactAllowed(G, NOW + HOUR)).toBe(true);
  });

  it('is independent per folder', () => {
    recordCompact(G, NOW);
    expect(isCompactAllowed(G, NOW + 1)).toBe(false);
    expect(isCompactAllowed('whatsapp_main', NOW + 1)).toBe(true);
  });

  it('a throttled folder decides warn, not compact', () => {
    recordCompact(G, NOW);
    expect(
      decideSessionAction({
        effectiveBytes: WARN + 1,
        mtimeMs: FRESH,
        now: NOW + 1,
        inFlight: false,
        abortAllowed: true,
        compactAllowed: isCompactAllowed(G, NOW + 1),
      }),
    ).toEqual({ kind: 'warn' });
  });
});
