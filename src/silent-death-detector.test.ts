import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({ DATA_DIR: '/tmp/nanoclaw-silent-death-test' }));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createDetector } from './silent-death-detector.js';

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
