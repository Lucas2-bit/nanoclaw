import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  QUEUE_HARD_TIMEOUT,
  TASK_HARD_TIMEOUT,
} from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

// Interval (ms) for the independent heartbeat tick written to queue-state.json.
const QUEUE_STATE_TICK_INTERVAL_MS = 90_000;
// Path to the out-of-process observable queue state file.
const QUEUE_STATE_PATH = path.join(DATA_DIR, 'queue-state.json');

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

/** How long to keep the circuit open before transitioning to half-open (ms). */
const CIRCUIT_RESET_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Circuit breaker states per group. */
export type CircuitState = 'closed' | 'open' | 'half-open';

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  /**
   * Monotonic counter incremented at the start of every runForGroup and again
   * when a run is abandoned via hang timeout. Lingering processGroupMessages
   * calls capture this at entry and skip cursor rollback if it has advanced,
   * because the timeout path owns requeue.
   */
  generation: number;
  retryCount: number;
  /** Circuit breaker state for this group. */
  circuitState: CircuitState;
  /** Timestamp (ms) when the circuit was opened; null when closed. */
  circuitOpenedAt: number | null;
  /** True when one probe message has been dispatched in half-open state. */
  halfOpenProbeDispatched: boolean;
}

/**
 * Result of a processGroupMessages run.
 * - ok: preserves the historical boolean meaning used for retry/circuit-breaker
 *   logic (false => schedule retry; no-op returns are ok:true and do NOT retry).
 * - ranToCompletion: true ONLY when a container actually spawned and delivered
 *   output end-to-end. Drives the D1 zero-success alarm. No-op returns are false.
 */
export interface ProcessResult {
  ok: boolean;
  ranToCompletion: boolean;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string) => Promise<ProcessResult>)
    | null = null;
  private notifyMainFn?: (text: string) => Promise<void>;
  private requeueFn?: (groupJid: string) => void;
  private shuttingDown = false;
  // Tracks the start time (ms) of the oldest currently-active run.
  // null when activeCount === 0.
  private oldestActiveStartedAt: number | null = null;
  // Handle for the independent tick timer (written regardless of busy loop state).
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // Timestamp (ms) of the most recent successful container completion.
  // Written to queue-state.json so the supervisor can detect the D1 alarm:
  // zero successful completions in a rolling window despite active containers.
  private lastSuccessAt: number | null = null;
  // Timestamp (ms) of the most recent moment there was OUTSTANDING work:
  // either a container was active OR a retry was scheduled. Lets the D1 alarm
  // consider "had active work within the window" instead of sampling
  // activeCount at a single instant (which can fall in a retry-backoff gap).
  private lastActiveAt: number | null = null;

  /**
   * Folder-level locking: maps a folder name to the JID currently running a
   * container against it. Prevents two JIDs sharing the same folder from
   * spawning concurrent containers (which would corrupt the Claude session).
   */
  private activeFolders = new Map<string, string>();

  /**
   * Optional callback that resolves a JID to its group folder name.
   * Set via setFolderResolver(). When provided, enables folder-level locking
   * so multiple JIDs sharing a folder are serialized.
   */
  private folderResolver: ((jid: string) => string | null) | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        generation: 0,
        retryCount: 0,
        circuitState: 'closed',
        circuitOpenedAt: null,
        halfOpenProbeDispatched: false,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  /**
   * Return the current run generation for a group. Callers capture this at
   * entry and re-check before mutating shared state; a mismatch means the run
   * was superseded (timeout or a fresh run started).
   */
  getGeneration(groupJid: string): number {
    return this.getGroup(groupJid).generation;
  }

  /**
   * Return the current circuit-breaker state for a group.
   * Advances an open circuit to half-open if the reset timeout has elapsed.
   */
  getCircuitState(groupJid: string): CircuitState {
    const state = this.groups.get(groupJid);
    if (!state) return 'closed';
    this.maybeAdvanceCircuit(groupJid, state);
    return state.circuitState;
  }

  /** Return the current number of active containers (for external health checks). */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Return true if a container run is currently in-flight for the given JID.
   * Used by the session monitor to defer a destructive archive-and-reset while
   * a reply is mid-generation for the group.
   */
  isActive(groupJid: string): boolean {
    return this.groups.get(groupJid)?.active === true;
  }

  /**
   * Atomically write queue state to QUEUE_STATE_PATH using temp-file + rename.
   * Also updates the tick_ts field so the supervisor can detect heartbeat staleness
   * independent of whether a write was triggered by a mutation or the tick timer.
   */
  private writeQueueState(): void {
    const state = {
      activeCount: this.activeCount,
      oldestActiveStartedAt: this.oldestActiveStartedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastActiveAt: this.lastActiveAt,
      tick_ts: Date.now(),
      ts: Date.now(),
    };
    const tmp = QUEUE_STATE_PATH + '.tmp';
    try {
      fs.mkdirSync(path.dirname(QUEUE_STATE_PATH), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, QUEUE_STATE_PATH);
    } catch (err) {
      logger.warn({ err }, 'queue-state write failed (non-fatal)');
    }
  }

  /**
   * Start the independent heartbeat tick timer.
   * This timer fires on its own interval — it is NOT driven by the busy loop,
   * so supervisor can distinguish a healthy-idle process from a hung one.
   * A stale tick_ts means the event loop is stalled.
   */
  startHeartbeatTick(): void {
    if (this.tickTimer) return; // already started
    this.tickTimer = setInterval(() => {
      this.writeQueueState();
    }, QUEUE_STATE_TICK_INTERVAL_MS);
    // Allow process to exit even if timer is running (unref so it doesn't hold event loop)
    if (
      this.tickTimer &&
      typeof (this.tickTimer as NodeJS.Timeout).unref === 'function'
    ) {
      (this.tickTimer as NodeJS.Timeout).unref();
    }
    // Write immediately on start
    this.writeQueueState();
  }

  /**
   * If the circuit is open and the reset timeout has elapsed, transition to
   * half-open so one probe message can get through.
   */
  private maybeAdvanceCircuit(groupJid: string, state: GroupState): void {
    if (
      state.circuitState === 'open' &&
      state.circuitOpenedAt !== null &&
      Date.now() - state.circuitOpenedAt >= CIRCUIT_RESET_TIMEOUT_MS
    ) {
      state.circuitState = 'half-open';
      state.halfOpenProbeDispatched = false;
      logger.info({ groupJid }, 'Circuit breaker: transitioning to half-open');
    }
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<ProcessResult>): void {
    this.processMessagesFn = fn;
  }

  setNotifyMainFn(fn: (text: string) => Promise<void>): void {
    this.notifyMainFn = fn;
  }

  setRequeueFn(fn: (groupJid: string) => void): void {
    this.requeueFn = fn;
  }

  /**
   * Race a worker promise against QUEUE_HARD_TIMEOUT (absolute, non-resetting).
   * A late rejection from `work` after the timeout wins is swallowed so it
   * never surfaces as an unhandledRejection.
   */
  private async withHardTimeout<T>(
    groupJid: string,
    label: 'message' | 'task',
    work: Promise<T>,
  ): Promise<
    | { status: 'done'; value: T }
    | { status: 'error'; error: unknown }
    | { status: 'timeout' }
  > {
    // Convert work's settlement into a tagged result so the race winner is
    // always a resolved value. The onRejected branch also acts as the
    // attached rejection handler — late rejections become resolved objects
    // and never propagate as unhandledRejection.
    const wrapped: Promise<
      { status: 'done'; value: T } | { status: 'error'; error: unknown }
    > = work.then(
      (value) => ({ status: 'done' as const, value }),
      (error) => ({ status: 'error' as const, error }),
    );

    // Scheduled tasks get the larger TASK_HARD_TIMEOUT backstop so long-running
    // jobs are not killed at the interactive-message ceiling; messages use
    // QUEUE_HARD_TIMEOUT.
    const hardTimeout =
      label === 'task' ? TASK_HARD_TIMEOUT : QUEUE_HARD_TIMEOUT;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'timeout' as const }),
        hardTimeout,
      );
    });

    const result = await Promise.race([wrapped, timeout]);
    if (timer) clearTimeout(timer);

    if (result.status === 'timeout') {
      logger.warn(
        { groupJid, label, timeoutMs: hardTimeout },
        'Queue hard timeout reached',
      );
    }
    return result;
  }

  /**
   * Kill the runaway container best-effort, then alert the main group.
   * Does NOT touch state.active / activeCount / folder lock — the caller's
   * finally block remains the single cleanup site.
   */
  private async handleHangTimeout(
    groupJid: string,
    state: GroupState,
    label: 'message' | 'task',
  ): Promise<void> {
    logger.error(
      { groupJid, containerName: state.containerName, label },
      'Hang timeout: killing container',
    );
    if (state.containerName) {
      try {
        stopContainer(state.containerName);
      } catch {
        try {
          state.process?.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
    } else {
      try {
        state.process?.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
    if (this.notifyMainFn) {
      const hardTimeout =
        label === 'task' ? TASK_HARD_TIMEOUT : QUEUE_HARD_TIMEOUT;
      try {
        await this.notifyMainFn(
          `Agent hang detected on group ${groupJid} (${label}): exceeded ${Math.round(hardTimeout / 60000)}m, container killed${label === 'message' ? ', message requeued' : ''}.`,
        );
      } catch (e) {
        logger.error({ e }, 'notifyMain failed');
      }
    }
  }

  /**
   * Set a function that resolves a JID to its group folder name.
   * Enables folder-level locking: if two JIDs share the same folder,
   * only one container runs at a time for that folder.
   */
  setFolderResolver(fn: (jid: string) => string | null): void {
    this.folderResolver = fn;
  }

  /**
   * Check if the folder for a given JID is currently in use by another JID's container.
   * Returns the folder name if busy, null if free.
   */
  private getFolderIfBusy(groupJid: string): string | null {
    if (!this.folderResolver) return null;
    const folder = this.folderResolver(groupJid);
    if (!folder) return null;
    const owner = this.activeFolders.get(folder);
    if (owner && owner !== groupJid) return folder;
    return null;
  }

  /**
   * Acquire a folder lock for the given JID. Returns the folder name (or null
   * if no resolver is set). The lock MUST be released in the finally block.
   */
  private acquireFolderLock(groupJid: string): string | null {
    if (!this.folderResolver) return null;
    const folder = this.folderResolver(groupJid);
    if (folder) {
      this.activeFolders.set(folder, groupJid);
      logger.debug({ groupJid, folder }, 'Folder lock acquired');
    }
    return folder;
  }

  /**
   * Release the folder lock and drain any JIDs waiting on the same folder.
   */
  private releaseFolderLock(folder: string | null, groupJid: string): void {
    if (!folder) return;
    const owner = this.activeFolders.get(folder);
    if (owner === groupJid) {
      this.activeFolders.delete(folder);
      logger.debug({ groupJid, folder }, 'Folder lock released');

      // Drain any other JIDs waiting on this folder
      this.drainFolderWaiters(folder, groupJid);
    }
  }

  /**
   * After releasing a folder lock, check if any waiting JIDs need that folder
   * and kick off their processing.
   */
  private drainFolderWaiters(folder: string, releasedByJid: string): void {
    if (!this.folderResolver) return;

    // Check waiting groups first
    for (let i = 0; i < this.waitingGroups.length; i++) {
      const waitingJid = this.waitingGroups[i];
      if (waitingJid === releasedByJid) continue;
      const waitingFolder = this.folderResolver(waitingJid);
      if (waitingFolder === folder) {
        // This JID was waiting for this folder — remove from waiting and process
        this.waitingGroups.splice(i, 1);
        const state = this.getGroup(waitingJid);
        if (state.pendingTasks.length > 0) {
          const task = state.pendingTasks.shift()!;
          this.runTask(waitingJid, task).catch((err) =>
            logger.error(
              { groupJid: waitingJid, taskId: task.id, err },
              'Unhandled error in runTask (folder drain)',
            ),
          );
        } else if (state.pendingMessages) {
          this.runForGroup(waitingJid, 'drain').catch((err) =>
            logger.error(
              { groupJid: waitingJid, err },
              'Unhandled error in runForGroup (folder drain)',
            ),
          );
        }
        return; // Only drain one waiter at a time
      }
    }

    // Also check all groups (some may have pending work but not be in waitingGroups)
    for (const [jid, state] of this.groups) {
      if (jid === releasedByJid) continue;
      if (state.active) continue;
      const jidFolder = this.folderResolver(jid);
      if (jidFolder !== folder) continue;
      if (state.pendingMessages || state.pendingTasks.length > 0) {
        this.drainGroup(jid);
        return;
      }
    }
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // --- Circuit breaker check ---
    this.maybeAdvanceCircuit(groupJid, state);
    if (state.circuitState === 'open') {
      logger.warn(
        { groupJid },
        'Circuit breaker open: rejecting message (will resume after reset timeout)',
      );
      return;
    }
    if (state.circuitState === 'half-open') {
      if (state.halfOpenProbeDispatched) {
        // Probe already in-flight; queue the message but don't start another run
        state.pendingMessages = true;
        logger.debug(
          { groupJid },
          'Circuit half-open: probe in-flight, message queued',
        );
        return;
      }
      // Allow exactly one probe through
      state.halfOpenProbeDispatched = true;
      logger.info({ groupJid }, 'Circuit breaker: dispatching half-open probe');
    }
    // --- End circuit breaker check ---

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    // --- Folder-level locking check ---
    const busyFolder = this.getFolderIfBusy(groupJid);
    if (busyFolder) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        {
          groupJid,
          folder: busyFolder,
          owner: this.activeFolders.get(busyFolder),
        },
        'Folder busy (shared session), message queued',
      );
      return;
    }
    // --- End folder-level locking check ---

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    // --- Folder-level locking check ---
    const busyFolder = this.getFolderIfBusy(groupJid);
    if (busyFolder) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, folder: busyFolder },
        'Folder busy (shared session), task queued',
      );
      return;
    }
    // --- End folder-level locking check ---

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    state.generation++;
    this.activeCount++;
    // Outstanding work exists right now (a container is starting). Drives the
    // D1 windowed active-work check so a retry-backoff gap cannot hide a dead
    // system from the supervisor.
    this.lastActiveAt = Date.now();
    // Track oldest active run start time for supervisor 90-min backstop.
    if (this.activeCount === 1) {
      this.oldestActiveStartedAt = Date.now();
    }
    this.writeQueueState();

    // Acquire folder lock
    const folder = this.acquireFolderLock(groupJid);

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount, folder },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const result = await this.withHardTimeout(
          groupJid,
          'message',
          this.processMessagesFn(groupJid),
        );
        if (result.status === 'timeout') {
          state.generation++;
          this.requeueFn?.(groupJid);
          await this.handleHangTimeout(groupJid, state, 'message');
          this.scheduleRetry(groupJid, state);
        } else if (result.status === 'error') {
          throw result.error;
        } else {
          // ok preserves the historical boolean: false => retry/circuit logic.
          // ranToCompletion is true ONLY for a genuine end-to-end run that
          // spawned a container and delivered output; no-op returns are false
          // and must NOT refresh the D1 liveness signal (the 05-31 blind spot).
          const { ok, ranToCompletion } = result.value;
          if (ok) {
            // On success: reset retry count and close circuit if it was half-open
            if (state.circuitState === 'half-open') {
              state.circuitState = 'closed';
              state.circuitOpenedAt = null;
              state.halfOpenProbeDispatched = false;
              logger.info(
                { groupJid },
                'Circuit breaker: probe succeeded, circuit closed',
              );
            }
            state.retryCount = 0;
            // Record successful completion for D1 alarm tracking ONLY when a
            // real run completed end-to-end. No-op returns (no group, no
            // missed messages, non-trigger) leave lastSuccessAt untouched.
            if (ranToCompletion) {
              this.lastSuccessAt = Date.now();
            }
          } else {
            this.scheduleRetry(groupJid, state);
          }
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      if (this.activeCount === 0) {
        this.oldestActiveStartedAt = null;
      }
      this.writeQueueState();
      // Release folder lock BEFORE draining so waiters can acquire it
      this.releaseFolderLock(folder, groupJid);
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;
    // Track oldest active run start time for supervisor 90-min backstop.
    if (this.activeCount === 1) {
      this.oldestActiveStartedAt = Date.now();
    }
    this.writeQueueState();

    // Acquire folder lock
    const folder = this.acquireFolderLock(groupJid);

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount, folder },
      'Running queued task',
    );

    try {
      const result = await this.withHardTimeout(groupJid, 'task', task.fn());
      if (result.status === 'timeout') {
        await this.handleHangTimeout(groupJid, state, 'task');
      } else if (result.status === 'error') {
        logger.error(
          { groupJid, taskId: task.id, err: result.error },
          'Error running task',
        );
      }
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      if (this.activeCount === 0) {
        this.oldestActiveStartedAt = null;
      }
      this.writeQueueState();
      // Release folder lock BEFORE draining so waiters can acquire it
      this.releaseFolderLock(folder, groupJid);
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    // A retry is outstanding work even though activeCount is momentarily 0
    // during backoff. Refresh lastActiveAt so the D1 windowed check still sees
    // the system as "working" across the backoff gap.
    this.lastActiveAt = Date.now();

    // If we were in half-open and the probe failed, reopen the circuit immediately
    if (state.circuitState === 'half-open') {
      logger.warn(
        { groupJid },
        'Circuit breaker: half-open probe failed, reopening circuit',
      );
      state.circuitState = 'open';
      state.circuitOpenedAt = Date.now();
      state.halfOpenProbeDispatched = false;
      state.retryCount = 0;
      return;
    }

    if (state.retryCount > MAX_RETRIES) {
      // Open the circuit — consecutive failure threshold exceeded
      state.circuitState = 'open';
      state.circuitOpenedAt = Date.now();
      state.halfOpenProbeDispatched = false;
      state.retryCount = 0;
      logger.error(
        {
          groupJid,
          resetInMs: CIRCUIT_RESET_TIMEOUT_MS,
        },
        'Circuit breaker: opened after max retries exceeded',
      );
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      // Check folder lock before starting
      const busyFolder = this.getFolderIfBusy(groupJid);
      if (busyFolder) {
        if (!this.waitingGroups.includes(groupJid)) {
          this.waitingGroups.push(groupJid);
        }
        return;
      }
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      // Check folder lock before starting
      const busyFolder = this.getFolderIfBusy(groupJid);
      if (busyFolder) {
        if (!this.waitingGroups.includes(groupJid)) {
          this.waitingGroups.push(groupJid);
        }
        return;
      }
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Check folder lock before starting
      const busyFolder = this.getFolderIfBusy(nextJid);
      if (busyFolder) {
        // Put it back at the end of the waiting list
        this.waitingGroups.push(nextJid);
        continue;
      }

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
