import fs from 'fs';
import path from 'path';

import { ALERT_POLL_MS, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const CONSUMED_DIR = path.join(ALERTS_DIR, 'consumed');

// Bound the consumed/ audit trail so it can never grow without limit.
const CONSUMED_RETENTION = 200;
const MAX_BODY_LOG = 2048;
// Cap body chars included in an ops alert so a huge drift payload can't blow
// past channel-side text limits when routed through routeOpsAlert.
const MAX_ALERT_BODY_CHARS = 512;

let timer: ReturnType<typeof setTimeout> | null = null;

// Edge-trigger state per inferSource: true = last scan saw a critical alert
// of that source. Cleared when a scan sees no alert of that source, so a real
// re-occurrence pages again. In-memory (Map, not persisted) — a restart is
// treated as a re-baseline point: any critical condition still present at
// restart re-pages on the first scan after restart, rather than silently
// staying suppressed under stale pre-restart state.
const lastScanCritical = new Map<string, boolean>();

// Default scope for `onAlert` narrowed to git-integrity — that's the specific
// source RISK-013 Chunk 4 exists to un-silence (~9h dist-drift gap on 07-09).
// Broadening to other sources can be a later deliberate decision, not the
// default.
const ALERT_ON_SOURCES = new Set<string>(['git-integrity']);

function inferSource(filename: string): string {
  if (filename.startsWith('channel-health-')) return 'channel-health';
  if (filename.startsWith('session-size-')) return 'session-monitor';
  if (filename.startsWith('git-integrity-')) return 'git-integrity';
  return 'unknown';
}

function ensureDirs(): boolean {
  try {
    fs.mkdirSync(CONSUMED_DIR, { recursive: true }); // also creates ALERTS_DIR
    return true;
  } catch (err) {
    logger.warn(
      { err, dir: CONSUMED_DIR },
      'alert-consumer: could not create alert dirs; not starting',
    );
    return false;
  }
}

// Move an alert into consumed/, never overwriting an existing audit record,
// with a cross-device (EXDEV) copy+unlink fallback.
function moveToConsumed(srcPath: string, filename: string): void {
  let dest = path.join(CONSUMED_DIR, filename);
  if (fs.existsSync(dest)) {
    dest = path.join(CONSUMED_DIR, `${filename}.${process.pid}.${Date.now()}`);
  }
  try {
    fs.renameSync(srcPath, dest);
  } catch (err: any) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(srcPath, dest);
      fs.unlinkSync(srcPath);
    } else {
      throw err;
    }
  }
}

function pruneConsumed(): void {
  try {
    const files = fs
      .readdirSync(CONSUMED_DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort(); // timestamped names sort oldest-first
    if (files.length <= CONSUMED_RETENTION) return;
    for (const name of files.slice(0, files.length - CONSUMED_RETENTION)) {
      try {
        fs.unlinkSync(path.join(CONSUMED_DIR, name));
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'alert-consumer: prune of consumed/ failed');
  }
}

function scanOnce(
  onAlert?: (msg: string) => void | Promise<void>,
): void {
  try {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ALERTS_DIR, { withFileTypes: true });
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        // dir not created yet — treat as no critical sources this scan so
        // any previously-set state clears correctly (e.g. after a manual
        // cleanup of the alerts dir).
        applyEdgeTriggerAndClear(new Set(), new Map(), onAlert);
        return;
      }
      throw err;
    }

    const files = entries
      .filter((d) => d.isFile()) // skips the consumed/ subdir and any non-regular entries
      .map((d) => d.name)
      .sort(); // chronological by timestamped filename

    // Per-scan collection so the edge-trigger fires ONCE per source per scan
    // (not once per file), and clears sources that are no longer critical.
    const criticalSourcesThisScan = new Set<string>();
    const firstBodyPerSource = new Map<string, string>();

    for (const filename of files) {
      const full = path.join(ALERTS_DIR, filename);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const body =
          raw.length > MAX_BODY_LOG
            ? `${raw.slice(0, MAX_BODY_LOG)}…[truncated]`
            : raw;
        const source = inferSource(filename);
        criticalSourcesThisScan.add(source);
        // Capture the first alert body per source for the ops-alert message
        // (files are sorted chronologically, so "first" = oldest).
        if (!firstBodyPerSource.has(source)) {
          firstBodyPerSource.set(
            source,
            raw.length > MAX_ALERT_BODY_CHARS
              ? `${raw.slice(0, MAX_ALERT_BODY_CHARS)}…[truncated]`
              : raw,
          );
        }
        // The originating event was already logged at error level by the writer;
        // this drain pass logs at warn so it does not double-count errors.
        logger.warn(
          { alert: filename, source, body },
          'alert-consumer: health alert drained',
        );
        moveToConsumed(full, filename);
      } catch (err) {
        // One bad file must never stop the others or throw out of the scan.
        logger.warn(
          { err, alert: filename },
          'alert-consumer: failed to process alert file',
        );
      }
    }

    if (files.length > 0) pruneConsumed();

    // Edge-trigger evaluation: fire onAlert ONLY on the transition from
    // non-critical → critical, per source in ALERT_ON_SOURCES. Sources that
    // were critical last scan but aren't this scan get their state cleared,
    // so a genuine re-occurrence in a later scan will re-page.
    applyEdgeTriggerAndClear(
      criticalSourcesThisScan,
      firstBodyPerSource,
      onAlert,
    );
  } catch (err) {
    // Absolute backstop: a scan must never throw.
    logger.warn({ err }, 'alert-consumer: scan failed');
  }
}

function applyEdgeTriggerAndClear(
  criticalSourcesThisScan: Set<string>,
  firstBodyPerSource: Map<string, string>,
  onAlert?: (msg: string) => void | Promise<void>,
): void {
  if (!onAlert) return;
  // Iterate the narrowed source set (git-integrity by default) so an unknown
  // or unscoped source can't accidentally page. Broaden ALERT_ON_SOURCES only
  // as a deliberate decision, not by default.
  for (const source of ALERT_ON_SOURCES) {
    const isCriticalNow = criticalSourcesThisScan.has(source);
    const wasCriticalBefore = lastScanCritical.get(source) === true;

    if (isCriticalNow && !wasCriticalBefore) {
      // Transition INTO critical — fire the alert exactly once.
      const body = firstBodyPerSource.get(source) ?? '(no body)';
      const msg =
        `alert-consumer: state changed to CRITICAL for source=${source} ` +
        `(first occurrence in this window; you will NOT be re-paged for the ` +
        `same ongoing condition until a scan clears and re-triggers). Body:\n${body}`;
      try {
        const p = onAlert(msg);
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch((err) =>
            logger.warn(
              { err, source },
              'alert-consumer: onAlert callback rejected',
            ),
          );
        }
      } catch (err) {
        logger.warn(
          { err, source },
          'alert-consumer: onAlert callback threw synchronously',
        );
      }
    }
    lastScanCritical.set(source, isCriticalNow);
  }
}

/**
 * Alert consumer. Drains DATA_DIR/alerts on startup and every ALERT_POLL_MS,
 * recording each alert once and moving it to alerts/consumed/. A
 * self-scheduling setTimeout avoids re-entrancy if scanOnce ever becomes
 * async. It never throws; it must never be able to take down the host process.
 *
 * @param onAlert  Optional callback invoked on the transition from
 *   non-critical → critical for a source in ALERT_ON_SOURCES (default:
 *   git-integrity only). RISK-013 Chunk 4: this is how the previously
 *   log-only consumer becomes edge-triggered pageable, without becoming
 *   level-triggered spam. Callers wire routeOpsAlert in here.
 */
export function startAlertConsumer(
  onAlert?: (msg: string) => void | Promise<void>,
): void {
  try {
    if (timer) return; // idempotent
    if (!ensureDirs()) return;

    const tick = (): void => {
      scanOnce(onAlert);
      timer = setTimeout(tick, ALERT_POLL_MS);
      timer.unref?.(); // never keep the event loop alive on the consumer's account
    };

    tick(); // immediate first drain (catches alerts written while the process was down)
    logger.info(
      { dir: ALERTS_DIR, pollMs: ALERT_POLL_MS, onAlertWired: !!onAlert },
      'alert-consumer started',
    );
  } catch (err) {
    logger.warn({ err }, 'alert-consumer: failed to start');
  }
}
