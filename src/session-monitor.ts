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
 * Check session file sizes for all registered groups.
 * Logs a warning when a session file exceeds WARN_THRESHOLD_BYTES.
 * When CRITICAL_THRESHOLD_BYTES is exceeded: logs an error, writes an alert
 * file, and invokes onCompact (if provided and cooldown has elapsed) to
 * automatically inject /compact into the group.
 *
 * Returns the number of groups whose active session files exceeded the
 * critical threshold.
 */
export function checkSessionFileSizes(
  registeredGroups: Record<string, RegisteredGroup>,
  onCompact?: CompactTrigger,
  onSessionReset?: SessionResetCallback,
  isFolderInFlight?: InFlightCheck,
): number {
  const sessions = getAllSessions();
  let criticalCount = 0;

  for (const [, group] of Object.entries(registeredGroups)) {
    const sessionId = sessions[group.folder];
    if (!sessionId) continue;

    const dir = sessionDir(group.folder);
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    let stat: fs.Stats;
    let sizeBytes: number;
    try {
      stat = fs.statSync(filePath);
      sizeBytes = stat.size;
    } catch {
      // File doesn't exist yet — not an error
      continue;
    }

    const sizeKB = Math.round(sizeBytes / 1024);

    if (sizeBytes >= HARD_CEILING_BYTES) {
      // HARD CEILING: archive the file and nuke the session.
      // Don't try to compact - that requires loading the bloated file.
      if (isFolderInFlight?.(group.folder)) {
        logger.warn(
          { groupFolder: group.folder, sessionId, sizeKB },
          'session-monitor: reset deferred — run in-flight, will retry next tick',
        );
        continue;
      }
      criticalCount++;
      const msg =
        `HARD CEILING: Session file for group "${group.folder}" is ${sizeKB} KB ` +
        `(limit: ${HARD_CEILING_BYTES / 1024} KB). Archiving and resetting.`;
      logger.error(
        { groupFolder: group.folder, sessionId, sizeKB },
        'session-monitor: HARD CEILING hit — archiving session',
      );
      writeAlertFile(msg);

      if (archiveAndResetSession(group.folder, sessionId)) {
        // Notify the main process to clear in-memory session state
        if (onSessionReset) {
          try {
            onSessionReset(group.folder);
          } catch (err) {
            logger.warn(
              { err, groupFolder: group.folder },
              'session-monitor: onSessionReset callback failed',
            );
          }
        }
      }
    } else if (sizeBytes >= CRITICAL_THRESHOLD_BYTES) {
      // Archive immediately — compaction at this size causes API timeouts.
      if (isFolderInFlight?.(group.folder)) {
        logger.warn(
          { groupFolder: group.folder, sessionId, sizeKB },
          'session-monitor: reset deferred — run in-flight, will retry next tick',
        );
        continue;
      }
      criticalCount++;
      const msg =
        `CRITICAL: Session file for group "${group.folder}" is ${sizeKB} KB ` +
        `(threshold: ${CRITICAL_THRESHOLD_BYTES / 1024} KB). Archiving and resetting.`;
      logger.error(
        { groupFolder: group.folder, sessionId, sizeKB },
        'session-monitor: CRITICAL threshold hit — archiving session',
      );
      writeAlertFile(msg);

      if (archiveAndResetSession(group.folder, sessionId)) {
        if (onSessionReset) {
          try {
            onSessionReset(group.folder);
          } catch (err) {
            logger.warn(
              { err, groupFolder: group.folder },
              'session-monitor: onSessionReset callback failed',
            );
          }
        }
      }
    } else if (sizeBytes >= WARN_THRESHOLD_BYTES) {
      const isStale =
        Date.now() - stat.mtimeMs > STALE_SESSION_HOURS * 3600 * 1000;
      if (isStale) {
        logger.info(
          { groupFolder: group.folder, sessionId, sizeKB },
          'session-monitor: archiving stale session (warn zone + stale)',
        );
        if (archiveAndResetSession(group.folder, sessionId)) {
          if (onSessionReset) {
            try {
              onSessionReset(group.folder);
            } catch (err) {
              logger.warn(
                { err, groupFolder: group.folder },
                'session-monitor: onSessionReset callback failed',
              );
            }
          }
        }
      } else {
        logger.warn(
          { groupFolder: group.folder, sessionId, sizeKB },
          'session-monitor: session file approaching size limit',
        );
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
): void {
  logger.info(
    {
      warnThresholdKB: WARN_THRESHOLD_BYTES / 1024,
      criticalThresholdKB: CRITICAL_THRESHOLD_BYTES / 1024,
      hardCeilingKB: HARD_CEILING_BYTES / 1024,
      intervalMs: CHECK_INTERVAL_MS,
      autoCompact: !!onCompact,
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
