import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllSessions, setSession } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Session file size at which a warning is logged. */
const WARN_THRESHOLD_BYTES = 300 * 1024; // 300 KB

/** Session file size at which a critical alert is triggered and the session is archived. */
const CRITICAL_THRESHOLD_BYTES = 600 * 1024; // 600 KB

/** How often to check session file sizes (ms). */
const CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds — fast enough to catch runaway sessions
const STALE_SESSION_HOURS = 24;

/**
 * Minimum time between auto-compact triggers for the same group (ms).
 * Prevents hammering /compact every 5 minutes if the session stays large.
 */
const COMPACT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Callback invoked when a session file exceeds the critical threshold and
 * a /compact should be injected into the group.
 * Receives the group folder name — the caller maps it to a JID.
 */
export type CompactTrigger = (groupFolder: string) => void;

/** Tracks the last time auto-compact was triggered per group folder. */
const lastCompactAt = new Map<string, number>();

/**
 * Resolve the Claude Code projects directory that corresponds to a
 * group folder.  Claude Code stores sessions under:
 *   ~/nanoclaw/data/sessions/{group_folder}/.claude/projects/-workspace-group/
 */
function sessionDir(groupFolder: string): string {
  return path.join(
    os.homedir(),
    'nanoclaw',
    'data',
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
}

/**
 * Write an alert file into DATA_DIR/alerts/ that the main process (or
 * Ulterior) can pick up.  The file is named with a timestamp so multiple
 * alerts don't overwrite each other.
 */
function writeAlertFile(message: string): void {
  try {
    const alertDir = path.join(DATA_DIR, 'alerts');
    fs.mkdirSync(alertDir, { recursive: true });
    const filename = `session-size-${Date.now()}.txt`;
    fs.writeFileSync(path.join(alertDir, filename), message, 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'session-monitor: failed to write alert file');
  }
}

/** Hard ceiling threshold - archive and nuke, don't try to compact. */
const HARD_CEILING_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Size at which we stop deferring and forcibly abort the in-flight run.
 *
 * HARD_CEILING is only enforceable when no run is active. A run may hold the
 * folder for up to QUEUE_HARD_TIMEOUT (90 min) or, for scheduled tasks,
 * TASK_HARD_TIMEOUT (270 min), and the defer response is identical regardless
 * of size — so a session can grow far past the "hard" ceiling that is supposed
 * to stop it. Measured on this host: sessions reached 3770 KB while deferring,
 * and 141 of 1515 archived sessions had breached 1 MB (largest 17300 KB).
 *
 * At this size the agent is at or past its usable context window and its
 * output is already degraded, so reclaiming the context is worth more than the
 * in-flight reply — which is requeued rather than lost (see
 * GroupQueue.abortActiveRun).
 *
 * Default is 2x HARD_CEILING: one doubling of headroom, so a run that crosses
 * 1 MB and finishes normally is never disturbed, while the observed 3.1-3.7 MB
 * cases are caught. Env-overridable so it can be retuned without a rebuild.
 */
const ABORT_CEILING_BYTES = parseInt(
  process.env.SESSION_ABORT_CEILING_BYTES || String(2 * 1024 * 1024),
  10,
);

/**
 * Aborting is throttled: `docker stop -t 1` plus teardown is not instant and
 * the monitor ticks every 60s, so an unthrottled abort would re-fire while the
 * previous kill is still settling. And if a single run inherently produces more
 * than ABORT_CEILING of output, abort -> fresh session -> regrow -> abort would
 * thrash. After ABORT_MAX_PER_HOUR we stop killing and escalate to a human
 * instead: a visible alert beats an invisible kill loop.
 */
const ABORT_COOLDOWN_MS = 5 * 60 * 1000;
const ABORT_MAX_PER_HOUR = 3;
const lastAbortAt = new Map<string, number>();
const abortHistory = new Map<string, number[]>();

/**
 * Whether an abort is permitted for this folder right now (cooldown + hourly
 * cap). Exported for testing; callers pass the result into
 * decideSessionAction so the decision itself stays pure.
 */
export function isAbortAllowed(groupFolder: string, now = Date.now()): boolean {
  const last = lastAbortAt.get(groupFolder);
  if (last !== undefined && now - last < ABORT_COOLDOWN_MS) return false;
  const recent = (abortHistory.get(groupFolder) || []).filter(
    (t) => now - t < 60 * 60 * 1000,
  );
  abortHistory.set(groupFolder, recent);
  return recent.length < ABORT_MAX_PER_HOUR;
}

/**
 * Record that an abort was issued, for cooldown/cap accounting.
 * Exported so the throttle logic can be tested directly — it is the part most
 * likely to carry an off-by-one, and a wrong cap here means either an
 * invisible kill loop or a ceiling that never enforces.
 */
export function recordAbort(groupFolder: string, now = Date.now()): void {
  lastAbortAt.set(groupFolder, now);
  const recent = (abortHistory.get(groupFolder) || []).filter(
    (t) => now - t < 60 * 60 * 1000,
  );
  recent.push(now);
  abortHistory.set(groupFolder, recent);
}

/** Reset abort throttling state. Test-only. */
export function __resetAbortState(): void {
  lastAbortAt.clear();
  abortHistory.clear();
}

/**
 * Size at which a silent /compact is injected.
 *
 * Deliberately well below CRITICAL. Auto-compact used to run AT critical, and
 * on 2026-04-29 that was replaced with archive because "compaction at this size
 * causes API timeouts" — which removed the only non-destructive step in the
 * ladder and left warn -> archive -> archive -> abort. Compacting early is the
 * way to get a working compaction step back.
 *
 * 300 KB has empirical support: archived sessions show compaction SUCCEEDING
 * with 531 KB and 570 KB of pre-boundary content, so this sits comfortably
 * below anything observed failing.
 */
const COMPACT_THRESHOLD_BYTES = parseInt(
  process.env.SESSION_COMPACT_THRESHOLD_BYTES || String(WARN_THRESHOLD_BYTES),
  10,
);

/**
 * Bytes after the last compact_boundary — the session's *effective* context.
 *
 * The .jsonl is an append-only transcript: once a compaction happens, prior
 * history is summarised and only the records after the boundary are live. Raw
 * file size therefore overstates context badly once a session has compacted.
 * Measured on archived sessions: 7200 KB total with 21 KB after the boundary,
 * 5440 KB -> 14 KB, 2075 KB -> 60 KB. Judging those by total size would archive
 * or abort perfectly healthy sessions.
 *
 * Falls back to total size when the session has never been compacted, so
 * never-compacted sessions behave exactly as before.
 *
 * Cached by (size, mtimeMs) so an unchanged file is scanned at most once.
 */
const effectiveCache = new Map<
  string,
  { size: number; mtimeMs: number; effective: number }
>();

/** Don't scan pathologically large transcripts; fall back to total size. */
const MAX_EFFECTIVE_SCAN_BYTES = 64 * 1024 * 1024;

export function effectiveSessionBytes(
  filePath: string,
  size: number,
  mtimeMs: number,
): number {
  const hit = effectiveCache.get(filePath);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.effective;

  let effective = size;
  if (size <= MAX_EFFECTIVE_SCAN_BYTES) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const idx = raw.lastIndexOf('compact_boundary');
      if (idx >= 0) {
        // Start of the line the boundary record sits on.
        const lineStart = raw.lastIndexOf('\n', idx) + 1;
        effective = Buffer.byteLength(raw.slice(lineStart), 'utf-8');
      }
    } catch {
      // Unreadable — fall back to total size rather than skipping the check.
      effective = size;
    }
  }

  effectiveCache.set(filePath, { size, mtimeMs, effective });
  return effective;
}

/** Reset the effective-size cache. Test-only. */
export function __resetEffectiveCache(): void {
  effectiveCache.clear();
}

/** Whether a /compact injection is permitted for this folder right now. */
export function isCompactAllowed(
  groupFolder: string,
  now = Date.now(),
): boolean {
  const last = lastCompactAt.get(groupFolder);
  return last === undefined || now - last >= COMPACT_COOLDOWN_MS;
}

/** Record that a /compact was injected, for cooldown accounting. */
export function recordCompact(groupFolder: string, now = Date.now()): void {
  lastCompactAt.set(groupFolder, now);
}

/** Reset compact cooldown state. Test-only. */
export function __resetCompactState(): void {
  lastCompactAt.clear();
}

/** What the monitor should do about one session file. */
export type SessionAction =
  | { kind: 'none' }
  | { kind: 'warn' }
  | { kind: 'compact' }
  | { kind: 'archive'; reason: 'stale' | 'critical' | 'hard' }
  | { kind: 'defer'; reason: 'critical' | 'hard' }
  | { kind: 'abort' };

/**
 * Decide what to do about a session file. Pure: no fs, no db, no clock, no
 * logging — the caller supplies every input and executes the result.
 *
 * Threshold order is highest-first. `abort` only applies when a run is
 * in-flight; when idle, an oversized session is simply archived, because the
 * normal path already works and there is nothing to kill.
 */
export function decideSessionAction(args: {
  /**
   * Bytes of LIVE context — i.e. after the last compact_boundary, not total
   * transcript length. See effectiveSessionBytes. Judging by total size
   * archives and aborts sessions that have already compacted and are healthy.
   */
  effectiveBytes: number;
  mtimeMs: number;
  now: number;
  inFlight: boolean;
  abortAllowed: boolean;
  compactAllowed: boolean;
}): SessionAction {
  const {
    effectiveBytes,
    mtimeMs,
    now,
    inFlight,
    abortAllowed,
    compactAllowed,
  } = args;

  if (effectiveBytes >= ABORT_CEILING_BYTES && inFlight) {
    // Throttled out: fall back to the ordinary defer rather than killing.
    return abortAllowed ? { kind: 'abort' } : { kind: 'defer', reason: 'hard' };
  }
  if (effectiveBytes >= HARD_CEILING_BYTES) {
    return inFlight
      ? { kind: 'defer', reason: 'hard' }
      : { kind: 'archive', reason: 'hard' };
  }
  if (effectiveBytes >= CRITICAL_THRESHOLD_BYTES) {
    return inFlight
      ? { kind: 'defer', reason: 'critical' }
      : { kind: 'archive', reason: 'critical' };
  }
  if (effectiveBytes >= WARN_THRESHOLD_BYTES) {
    // Stale wins over compact: nobody is using this session, so summarising it
    // is pointless — archive it as before.
    const isStale = now - mtimeMs > STALE_SESSION_HOURS * 3600 * 1000;
    if (isStale) return { kind: 'archive', reason: 'stale' };
    // The non-destructive step: shrink the live context while preserving
    // continuity, so the session never reaches the archiving thresholds above.
    if (effectiveBytes >= COMPACT_THRESHOLD_BYTES && compactAllowed) {
      return { kind: 'compact' };
    }
    return { kind: 'warn' };
  }
  return { kind: 'none' };
}

/**
 * Archive a session file by moving it to an archive directory.
 * This is a hard reset - the session is gone, next agent run starts fresh.
 * Returns true if the archive succeeded.
 */
function archiveAndResetSession(
  groupFolder: string,
  sessionId: string,
): boolean {
  const dir = sessionDir(groupFolder);
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const archiveDir = path.join(DATA_DIR, 'session-archive', groupFolder);

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `${sessionId}_${timestamp}.jsonl`;
    fs.renameSync(filePath, path.join(archiveDir, archiveName));

    // Clear the session from the DB so next run starts fresh
    setSession(groupFolder, '');

    logger.info(
      { groupFolder, sessionId, archiveName },
      'session-monitor: HARD CEILING - session archived and reset',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, groupFolder, sessionId },
      'session-monitor: failed to archive session file',
    );
    return false;
  }
}

/** Callback to clear in-memory session state after a hard reset. */
export type SessionResetCallback = (groupFolder: string) => void;

/**
 * Predicate returning true when a container run is currently in-flight for the
 * given group folder. When true, a destructive archive-and-reset is deferred
 * to the next monitor tick so an in-flight reply is not discarded.
 */
export type InFlightCheck = (groupFolder: string) => boolean;

/**
 * Callback invoked when a session has grown past ABORT_CEILING_BYTES while a
 * container run is still in-flight. The implementation is expected to kill that
 * run (requeueing the user's message so the reply is regenerated, not lost).
 * The archive itself happens on a LATER tick, once the run has cleared.
 */
export type AbortRunCallback = (groupFolder: string, reason: string) => void;

/**
 * Check session file sizes for all registered groups and act on each.
 *
 * The decision is made by decideSessionAction (pure, unit-tested); this
 * function is the IO shell that gathers inputs and executes the result.
 *
 * Returns the number of groups whose session files were at or past the
 * critical threshold and required a destructive action.
 *
 * `onCompact` injects a silent /compact once the LIVE context (not raw
 * transcript size) passes COMPACT_THRESHOLD_BYTES. This is the only
 * non-destructive step in the ladder; without it a bloating session is only
 * ever archived, losing all continuity.
 */
export function checkSessionFileSizes(
  registeredGroups: Record<string, RegisteredGroup>,
  onCompact?: CompactTrigger,
  onSessionReset?: SessionResetCallback,
  isFolderInFlight?: InFlightCheck,
  onAbortRun?: AbortRunCallback,
): number {
  const sessions = getAllSessions();
  let criticalCount = 0;
  const now = Date.now();

  for (const [, group] of Object.entries(registeredGroups)) {
    const sessionId = sessions[group.folder];
    if (!sessionId) continue;

    const dir = sessionDir(group.folder);
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // File doesn't exist yet — not an error
      continue;
    }

    const sizeBytes = stat.size;
    const sizeKB = Math.round(sizeBytes / 1024);
    // Only scan for a compact boundary once the transcript is large enough to
    // matter — small sessions cost nothing beyond the statSync above.
    const effectiveBytes =
      sizeBytes >= WARN_THRESHOLD_BYTES
        ? effectiveSessionBytes(filePath, sizeBytes, stat.mtimeMs)
        : sizeBytes;
    const effectiveKB = Math.round(effectiveBytes / 1024);
    const inFlight = isFolderInFlight?.(group.folder) ?? false;
    const action = decideSessionAction({
      effectiveBytes,
      mtimeMs: stat.mtimeMs,
      now,
      inFlight,
      abortAllowed: isAbortAllowed(group.folder, now),
      compactAllowed: isCompactAllowed(group.folder, now),
    });

    // Both sizes are logged: effective drives the decision, total explains why
    // a multi-MB file may legitimately need no action.
    const meta = {
      groupFolder: group.folder,
      sessionId,
      sizeKB,
      effectiveKB,
    };

    switch (action.kind) {
      case 'none':
        break;

      case 'warn':
        logger.warn(
          meta,
          'session-monitor: session file approaching size limit',
        );
        break;

      case 'defer':
        logger.warn(
          meta,
          'session-monitor: reset deferred — run in-flight, will retry next tick',
        );
        break;

      case 'compact': {
        if (!onCompact) {
          logger.warn(
            meta,
            'session-monitor: compact threshold reached but no onCompact wired',
          );
          break;
        }
        // Record before invoking: if the injection throws we still respect the
        // cooldown rather than retrying every 60s.
        recordCompact(group.folder, now);
        logger.info(
          meta,
          'session-monitor: compact threshold reached — injecting silent /compact',
        );
        try {
          onCompact(group.folder);
        } catch (err) {
          logger.warn(
            { err, groupFolder: group.folder },
            'session-monitor: auto-compact trigger failed',
          );
        }
        break;
      }

      case 'abort': {
        criticalCount++;
        const reason =
          `session ${sizeKB} KB exceeded abort ceiling ` +
          `(${Math.round(ABORT_CEILING_BYTES / 1024)} KB) with a run in-flight`;
        logger.error(
          meta,
          'session-monitor: ABORT CEILING hit — killing in-flight run so the session can be reset',
        );
        writeAlertFile(
          `ABORT CEILING: ${reason} for group "${group.folder}". ` +
            `Killing the run; the message is requeued and the session will be ` +
            `archived on the next tick.`,
        );
        recordAbort(group.folder, now);
        if (onAbortRun) {
          try {
            onAbortRun(group.folder, reason);
          } catch (err) {
            logger.error(
              { err, groupFolder: group.folder },
              'session-monitor: onAbortRun callback failed',
            );
          }
        } else {
          logger.warn(
            meta,
            'session-monitor: abort ceiling hit but no onAbortRun wired — cannot reclaim',
          );
        }
        break;
      }

      case 'archive': {
        if (action.reason === 'stale') {
          logger.info(
            meta,
            'session-monitor: archiving stale session (warn zone + stale)',
          );
        } else {
          criticalCount++;
          const label = action.reason === 'hard' ? 'HARD CEILING' : 'CRITICAL';
          const limitKB =
            action.reason === 'hard'
              ? HARD_CEILING_BYTES / 1024
              : CRITICAL_THRESHOLD_BYTES / 1024;
          logger.error(
            meta,
            `session-monitor: ${label} hit — archiving session`,
          );
          writeAlertFile(
            `${label}: Session file for group "${group.folder}" is ${sizeKB} KB ` +
              `(limit: ${limitKB} KB). Archiving and resetting.`,
          );
        }
        if (archiveAndResetSession(group.folder, sessionId) && onSessionReset) {
          try {
            onSessionReset(group.folder);
          } catch (err) {
            logger.warn(
              { err, groupFolder: group.folder },
              'session-monitor: onSessionReset callback failed',
            );
          }
        }
        break;
      }
    }
  }

  return criticalCount;
}

/**
 * Start the periodic session file size monitor.
 * Should be called once during application startup.
 *
 * Checks run every CHECK_INTERVAL_MS (5 minutes).  The first check is
 * deferred by one full interval so it does not fire during the busy startup
 * phase before sessions are fully attached.
 *
 * @param getRegisteredGroups - Callback returning the current registered
 *   groups map.  Called at each interval so newly-registered groups are
 *   included automatically.
 * @param onCompact - Optional callback invoked when a session exceeds the
 *   critical threshold.  Receives the group folder name.  The caller is
 *   responsible for injecting /compact into the group's message queue.
 *   A 10-minute cooldown prevents repeated triggers for the same group.
 */
/**
 * Pre-flight check: returns the session file size in bytes for a group,
 * or 0 if no active session file exists.
 */
export function getSessionFileSize(
  groupFolder: string,
  sessionId: string | undefined,
): number {
  if (!sessionId) return 0;
  const filePath = path.join(sessionDir(groupFolder), `${sessionId}.jsonl`);
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function startSessionMonitor(
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
  onCompact?: CompactTrigger,
  onSessionReset?: SessionResetCallback,
  isFolderInFlight?: InFlightCheck,
  onAbortRun?: AbortRunCallback,
): void {
  logger.info(
    {
      warnThresholdKB: WARN_THRESHOLD_BYTES / 1024,
      compactThresholdKB: COMPACT_THRESHOLD_BYTES / 1024,
      criticalThresholdKB: CRITICAL_THRESHOLD_BYTES / 1024,
      hardCeilingKB: HARD_CEILING_BYTES / 1024,
      abortCeilingKB: ABORT_CEILING_BYTES / 1024,
      // Thresholds are measured against LIVE context (bytes since the last
      // compact_boundary), not raw transcript size.
      metric: 'effective-bytes',
      autoCompactWired: !!onCompact,
      abortWired: !!onAbortRun,
      intervalMs: CHECK_INTERVAL_MS,
    },
    'session-monitor: started',
  );

  const loop = () => {
    try {
      checkSessionFileSizes(
        getRegisteredGroups(),
        onCompact,
        onSessionReset,
        isFolderInFlight,
      );
    } catch (err) {
      logger.warn({ err }, 'session-monitor: error during check');
    }
    setTimeout(loop, CHECK_INTERVAL_MS);
  };

  setTimeout(loop, CHECK_INTERVAL_MS);
}
