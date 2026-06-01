// Silent-death detector: alarms when prompts arrive but zero container runs
// succeed over a rolling window — the failure mode that left a stale host
// `dist/` causing every container to fail-closed for ~7h while the parent
// process and watchdog stayed healthy.
//
// Two independent alarm signals:
//   1. promptsStarted >= N AND containerSuccesses == 0 in window
//   2. SAFETY_BLOCK-missing markers >= N in window (separate signal so the
//      operator hears about the root cause even before signal 1 trips)
//
// Failsafe: every public entry point is wrapped so the detector cannot
// throw into the main message path. On its own error it degrades to a log.
//
// Detection of the SAFETY_BLOCK pattern is done by string match on the
// `error` field returned from runContainerAgent; this catches both the
// host-side pre-spawn check (src/container-runner.ts) and the container's
// internal fail-closed marker propagated back via stderr tail.

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const DEFAULT_WINDOW_MS = parseInt(
  process.env.SILENT_DEATH_WINDOW_MS || `${15 * 60 * 1000}`,
  10,
);
const DEFAULT_PROMPT_THRESHOLD = parseInt(
  process.env.SILENT_DEATH_PROMPT_THRESHOLD || '3',
  10,
);
const DEFAULT_SAFETY_THRESHOLD = parseInt(
  process.env.SILENT_DEATH_SAFETY_THRESHOLD || '3',
  10,
);
const DEFAULT_EVAL_MS = parseInt(
  process.env.SILENT_DEATH_EVAL_MS || '60000',
  10,
);

// String match catches both the host-side pre-spawn refuse and the
// container-side fail-closed marker propagated through stderr tail.
const SAFETY_BLOCK_RE =
  /SAFETY_BLOCK\b.*\b(missing|empty)|refusing to invoke model|refusing to spawn/i;

export type AlarmKind = 'silent-death' | 'safety-block-loop' | null;

export interface DetectorConfig {
  windowMs: number;
  promptThreshold: number;
  safetyBlockThreshold: number;
  now: () => number;
}

export interface EvalResult {
  alarm: boolean;
  kind: AlarmKind;
  prompts: number;
  successes: number;
  safetyBlockMisses: number;
  reason: string;
}

export interface Detector {
  recordPromptStarted: () => void;
  recordContainerSuccess: () => void;
  recordSafetyBlockMissing: () => void;
  /** Inspect an error string and record a safety-block miss iff it matches. */
  observeError: (errorMessage: string | undefined) => void;
  evaluate: () => EvalResult;
}

export function createDetector(config?: Partial<DetectorConfig>): Detector {
  const cfg: DetectorConfig = {
    windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
    promptThreshold: config?.promptThreshold ?? DEFAULT_PROMPT_THRESHOLD,
    safetyBlockThreshold:
      config?.safetyBlockThreshold ?? DEFAULT_SAFETY_THRESHOLD,
    now: config?.now ?? (() => Date.now()),
  };

  const prompts: number[] = [];
  const successes: number[] = [];
  const safetyBlockMisses: number[] = [];
  let lastAlarmAt = 0;

  function prune(now: number): void {
    const cutoff = now - cfg.windowMs;
    while (prompts.length > 0 && prompts[0] < cutoff) prompts.shift();
    while (successes.length > 0 && successes[0] < cutoff) successes.shift();
    while (safetyBlockMisses.length > 0 && safetyBlockMisses[0] < cutoff) {
      safetyBlockMisses.shift();
    }
  }

  function recordPromptStarted(): void {
    prompts.push(cfg.now());
  }
  function recordContainerSuccess(): void {
    successes.push(cfg.now());
  }
  function recordSafetyBlockMissing(): void {
    safetyBlockMisses.push(cfg.now());
  }
  function observeError(errorMessage: string | undefined): void {
    if (
      typeof errorMessage === 'string' &&
      SAFETY_BLOCK_RE.test(errorMessage)
    ) {
      recordSafetyBlockMissing();
    }
  }

  function evaluate(): EvalResult {
    const now = cfg.now();
    prune(now);
    const p = prompts.length;
    const s = successes.length;
    const m = safetyBlockMisses.length;

    const inDedupe = now - lastAlarmAt < cfg.windowMs;
    let kind: AlarmKind = null;
    let alarm = false;
    let reason = '';
    const windowMin = Math.round(cfg.windowMs / 60000);

    if (p >= cfg.promptThreshold && s === 0) {
      kind = 'silent-death';
      alarm = !inDedupe;
      reason = `${p} prompts, 0 successful runs in ${windowMin}m`;
    } else if (m >= cfg.safetyBlockThreshold) {
      kind = 'safety-block-loop';
      alarm = !inDedupe;
      reason = `${m} SAFETY_BLOCK-missing events in ${windowMin}m`;
    }

    if (alarm) lastAlarmAt = now;
    return {
      alarm,
      kind,
      prompts: p,
      successes: s,
      safetyBlockMisses: m,
      reason,
    };
  }

  return {
    recordPromptStarted,
    recordContainerSuccess,
    recordSafetyBlockMissing,
    observeError,
    evaluate,
  };
}

// Module-level singleton used by production hooks. Tests must use createDetector.
const detector = createDetector();

export function recordPromptStarted(): void {
  try {
    detector.recordPromptStarted();
  } catch (err) {
    logger.warn({ err }, 'silent-death: recordPromptStarted failed');
  }
}

export function recordContainerSuccess(): void {
  try {
    detector.recordContainerSuccess();
  } catch (err) {
    logger.warn({ err }, 'silent-death: recordContainerSuccess failed');
  }
}

export function observeContainerError(errorMessage: string | undefined): void {
  try {
    detector.observeError(errorMessage);
  } catch (err) {
    logger.warn({ err }, 'silent-death: observeContainerError failed');
  }
}

function writeAlertFile(kind: string, body: string): void {
  try {
    const alertDir = path.join(DATA_DIR, 'alerts');
    fs.mkdirSync(alertDir, { recursive: true });
    const filename = `silent-death-${kind}-${Date.now()}.txt`;
    fs.writeFileSync(path.join(alertDir, filename), body, 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'silent-death: failed to write alert file');
  }
}

/**
 * Start the periodic evaluator. Polls every pollMs and, on alarm, writes an
 * alert file, logs at error, and fires notifyMain with plain operational
 * text (no allergen+affirmative content, so guardedOutbound passes).
 *
 * Never throws.
 */
export function startSilentDeathDetector(
  notifyMain: (text: string) => Promise<void>,
  pollMs: number = DEFAULT_EVAL_MS,
): void {
  const tick = (): void => {
    try {
      const result = detector.evaluate();
      if (result.alarm) {
        const headline =
          result.kind === 'safety-block-loop'
            ? `SILENT DEATH DETECTED (safety-block loop): ${result.reason}`
            : `SILENT DEATH DETECTED: ${result.reason}`;
        logger.error(
          {
            kind: result.kind,
            prompts: result.prompts,
            successes: result.successes,
            safetyBlockMisses: result.safetyBlockMisses,
          },
          headline,
        );
        writeAlertFile(
          result.kind ?? 'unknown',
          [
            `${new Date().toISOString()} ${headline}`,
            `prompts=${result.prompts}`,
            `successes=${result.successes}`,
            `safetyBlockMisses=${result.safetyBlockMisses}`,
          ].join('\n'),
        );
        // Plain operational text — no allergen terms, no affirmative
        // context — so guardedOutbound's screener returns pass.
        notifyMain(
          `[ops] ${headline}. Inspect host dist/ and container logs; watchdog did not catch this.`,
        ).catch((err) =>
          logger.warn({ err }, 'silent-death: notifyMain failed'),
        );
      }
    } catch (err) {
      logger.warn({ err }, 'silent-death: tick failed');
    }
    const t = setTimeout(tick, pollMs);
    t.unref?.();
  };

  // Defer first tick by pollMs so transient startup state can settle.
  const t = setTimeout(tick, pollMs);
  t.unref?.();
  logger.info(
    {
      windowMs: DEFAULT_WINDOW_MS,
      pollMs,
      promptThreshold: DEFAULT_PROMPT_THRESHOLD,
      safetyBlockThreshold: DEFAULT_SAFETY_THRESHOLD,
    },
    'silent-death detector started',
  );
}
