import fs from 'fs';
import path from 'path';

import { ALERT_POLL_MS, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const CONSUMED_DIR = path.join(ALERTS_DIR, 'consumed');

// Bound the consumed/ audit trail so it can never grow without limit.
const CONSUMED_RETENTION = 200;
const MAX_BODY_LOG = 2048;

let timer: ReturnType<typeof setTimeout> | null = null;

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

function scanOnce(): void {
  try {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ALERTS_DIR, { withFileTypes: true });
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return; // dir not created yet
      throw err;
    }

    const files = entries
      .filter((d) => d.isFile()) // skips the consumed/ subdir and any non-regular entries
      .map((d) => d.name)
      .sort(); // chronological by timestamped filename

    for (const filename of files) {
      const full = path.join(ALERTS_DIR, filename);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const body =
          raw.length > MAX_BODY_LOG
            ? `${raw.slice(0, MAX_BODY_LOG)}…[truncated]`
            : raw;
        // The originating event was already logged at error level by the writer;
        // this drain pass logs at warn so it does not double-count errors.
        logger.warn(
          { alert: filename, source: inferSource(filename), body },
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
  } catch (err) {
    // Absolute backstop: a scan must never throw.
    logger.warn({ err }, 'alert-consumer: scan failed');
  }
}

/**
 * Log-only alert consumer. Drains DATA_DIR/alerts on startup and every
 * ALERT_POLL_MS, recording each alert once and moving it to alerts/consumed/.
 * A self-scheduling setTimeout avoids re-entrancy if scanOnce ever becomes async.
 * It never throws; it must never be able to take down the host process.
 */
export function startAlertConsumer(): void {
  try {
    if (timer) return; // idempotent
    if (!ensureDirs()) return;

    const tick = (): void => {
      scanOnce();
      timer = setTimeout(tick, ALERT_POLL_MS);
      timer.unref?.(); // never keep the event loop alive on the consumer's account
    };

    tick(); // immediate first drain (catches alerts written while the process was down)
    logger.info(
      { dir: ALERTS_DIR, pollMs: ALERT_POLL_MS },
      'alert-consumer started',
    );
  } catch (err) {
    logger.warn({ err }, 'alert-consumer: failed to start');
  }
}
