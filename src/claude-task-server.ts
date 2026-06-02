/**
 * Claude Code task server — lets containers invoke the Claude CLI on the host.
 *
 * v2 (cycle 2.5): async-first job model + bounded FIFO queue (concurrency 1).
 *
 *   POST /claude-task { prompt, timeout?, wait? }
 *     - Creates a job (status `queued`), persists it, enqueues it.
 *     - wait omitted/true  -> long-poll up to CLAUDE_TASK_SYNC_WAIT_MS (<=30s).
 *         If done in time: today's shape { ok, output, ... } + job_id + emptyOutput.
 *         If not: 202 { ok:true, job_id, status:'running' }.
 *     - wait:false         -> 202 { ok:true, job_id, status } immediately.
 *   GET  /claude-task/:job_id -> 200 full job record | 404 JOB_NOT_FOUND.
 *   GET  /health              -> 200 { ok, status:'up', version, busy,
 *                                      queueDepth, activeJobId, uptimeMs }.
 *
 * Concurrency stays 1 (one `claude` CLI on the host). busy/active is DERIVED
 * from the queue — no separate checked-then-set boolean. 429 QUEUE_FULL is
 * returned ONLY when the queue is full (CLAUDE_TASK_MAX_QUEUE).
 *
 * Binds to 127.0.0.1 only (containers reach via host.docker.internal).
 * Interrupted jobs are NEVER auto-rerun — the caller re-submits.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

import { CLAUDE_TASK_MAX_QUEUE, CLAUDE_TASK_SYNC_WAIT_MS } from './config.js';
import { logger } from './logger.js';
import {
  generateJobId,
  writeJob,
  readJob,
  reconcileZombieJobs,
  pruneJobs,
  JobRecord,
} from './claude-task-store.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const MAX_TIMEOUT = 600_000; // 10 minutes
const KILL_GRACE_MS = 5_000; // SIGTERM -> SIGKILL grace on timeout

type ErrorCode =
  | 'INVALID_JSON'
  | 'MISSING_PROMPT'
  | 'QUEUE_FULL'
  | 'TIMEOUT'
  | 'SPAWN_ERROR'
  | 'JOB_NOT_FOUND'
  | 'NOT_FOUND'
  | 'INTERNAL';

// --- version (best-effort; never throws) --------------------------------
const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    );
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const SERVER_START = Date.now();

// --- queue (concurrency 1, busy/active derived) -------------------------
interface PendingJob {
  record: JobRecord;
  timeoutMs: number;
  done: Promise<JobRecord>;
  resolveDone: (r: JobRecord) => void;
}

const queue: PendingJob[] = [];
let activeJobId: string | null = null;
let draining = false;

function nowIso(): string {
  return new Date().toISOString();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      activeJobId = item.record.job_id;
      item.record.status = 'running';
      item.record.startedAt = nowIso();
      writeJob(item.record); // write #1 lifts to running
      logger.info(
        { job_id: item.record.job_id, timeout: item.timeoutMs },
        'Claude task started',
      );

      let terminal: JobRecord;
      try {
        terminal = await runClaude(item.record, item.timeoutMs);
      } catch (err) {
        // runClaude never rejects, but guard so the drain loop can't die.
        terminal = {
          ...item.record,
          status: 'failed',
          finishedAt: nowIso(),
          error: err instanceof Error ? err.message : String(err),
          errorCode: 'INTERNAL',
        };
      }
      writeJob(terminal); // write #2 (terminal)
      activeJobId = null;
      logger.info(
        {
          job_id: terminal.job_id,
          status: terminal.status,
          emptyOutput: terminal.emptyOutput === true,
          outputLength: terminal.output ? terminal.output.length : 0,
        },
        'Claude task completed',
      );
      item.resolveDone(terminal);
    }
  } finally {
    activeJobId = null;
    draining = false;
  }
}

/**
 * Spawn `claude`, resolve with a TERMINAL job record (done|failed|timeout).
 * Never rejects. Dual-timeout: spawn `timeout` option + manual setTimeout;
 * on fire, status `timeout` + SIGTERM, then SIGKILL after KILL_GRACE_MS.
 */
function runClaude(record: JobRecord, timeoutMs: number): Promise<JobRecord> {
  return new Promise((resolve) => {
    const args = ['-p', record.prompt, '--dangerously-skip-permissions'];

    let child: ChildProcess;
    try {
      child = spawn('claude', args, {
        cwd: process.cwd(),
        timeout: timeoutMs,
        env: { ...process.env },
      });
    } catch (err) {
      resolve({
        ...record,
        status: 'failed',
        finishedAt: nowIso(),
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'SPAWN_ERROR',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const settle = (rec: JobRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rec);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      // Belt-and-braces kill: SIGTERM now, SIGKILL after a short grace if the
      // child ignores it. killTimer is intentionally NOT cleared by settle().
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, KILL_GRACE_MS);
      settle({
        ...record,
        status: 'timeout',
        finishedAt: nowIso(),
        output: stdout.trim() || undefined,
        stderr: stderr.trim() || undefined,
        error: `Timed out after ${timeoutMs}ms`,
        errorCode: 'TIMEOUT',
      });
    }, timeoutMs);

    child.on('close', (code) => {
      // Child exited — no need to SIGKILL.
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      const trimmed = stdout.trim();
      if (code === 0) {
        settle({
          ...record,
          status: 'done',
          exitCode: 0,
          output: trimmed,
          emptyOutput: trimmed.length === 0,
          stderr: stderr.trim() || undefined,
          finishedAt: nowIso(),
        });
      } else {
        settle({
          ...record,
          status: 'failed',
          exitCode: code,
          output: trimmed || undefined,
          stderr: stderr.trim() || undefined,
          error: stderr.trim() || `Exit code ${code}`,
          errorCode: 'INTERNAL',
          finishedAt: nowIso(),
        });
      }
    });

    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      settle({
        ...record,
        status: 'failed',
        finishedAt: nowIso(),
        error: err.message,
        errorCode: 'SPAWN_ERROR',
      });
    });
  });
}

// --- response helpers ---------------------------------------------------
function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  code: number,
  errorCode: ErrorCode,
  error: string,
): void {
  sendJson(res, code, { ok: false, error, errorCode });
}

/** Map a terminal job record to today's sync response shape (+ job_id). */
function syncResponse(rec: JobRecord): { code: number; body: unknown } {
  if (rec.status === 'done') {
    return {
      code: 200,
      body: {
        ok: true,
        output: rec.output ?? '',
        emptyOutput: rec.emptyOutput === true,
        job_id: rec.job_id,
        status: rec.status,
        ...(rec.stderr ? { stderr: rec.stderr } : {}),
      },
    };
  }
  return {
    code: rec.status === 'timeout' ? 504 : 500,
    body: {
      ok: false,
      error: rec.error ?? `Task ${rec.status}`,
      errorCode: rec.errorCode ?? 'INTERNAL',
      job_id: rec.job_id,
      status: rec.status,
      emptyOutput: rec.emptyOutput === true,
    },
  };
}

/** Resolve when `p` settles, or null after `ms`. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

// --- request handlers ---------------------------------------------------
function handlePost(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let body: { prompt?: unknown; timeout?: unknown; wait?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      sendError(res, 400, 'INVALID_JSON', 'Invalid JSON');
      return;
    }

    if (!body.prompt || typeof body.prompt !== 'string') {
      sendError(res, 400, 'MISSING_PROMPT', 'Missing prompt string');
      return;
    }
    const prompt = body.prompt;

    // 429 ONLY when the pending queue is full. busy/active is derived: a job
    // is admitted whenever there is queue room, regardless of the active slot.
    if (queue.length >= CLAUDE_TASK_MAX_QUEUE) {
      sendError(res, 429, 'QUEUE_FULL', 'Task queue is full');
      return;
    }

    const timeoutMs = Math.min(
      Math.max(
        typeof body.timeout === 'number' ? body.timeout : DEFAULT_TIMEOUT,
        1000,
      ),
      MAX_TIMEOUT,
    );

    const record: JobRecord = {
      job_id: generateJobId(),
      status: 'queued',
      prompt,
      promptLength: prompt.length,
      timeoutMs,
      createdAt: nowIso(),
    };
    writeJob(record);

    let resolveDone!: (r: JobRecord) => void;
    const done = new Promise<JobRecord>((r) => {
      resolveDone = r;
    });
    queue.push({ record, timeoutMs, done, resolveDone });
    // Fire-and-forget; drain never rejects.
    void drain();

    const wait = body.wait !== false; // omitted or true => sync sugar
    if (!wait) {
      sendJson(res, 202, {
        ok: true,
        job_id: record.job_id,
        status: record.status,
      });
      return;
    }

    // Sync sugar: long-poll up to the (<=30s) cap, then fall back to async.
    raceTimeout(done, CLAUDE_TASK_SYNC_WAIT_MS).then((terminal) => {
      if (terminal) {
        const { code, body: respBody } = syncResponse(terminal);
        sendJson(res, code, respBody);
      } else {
        sendJson(res, 202, {
          ok: true,
          job_id: record.job_id,
          status: 'running',
        });
      }
    });
  });
}

function handleGetJob(res: ServerResponse, jobId: string): void {
  const record = readJob(jobId);
  if (!record) {
    sendError(res, 404, 'JOB_NOT_FOUND', `No job ${jobId}`);
    return;
  }
  sendJson(res, 200, record);
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    status: 'up',
    version: VERSION,
    busy: activeJobId !== null,
    queueDepth: queue.length,
    activeJobId,
    uptimeMs: Date.now() - SERVER_START,
  });
}

export function startClaudeTaskServer(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Startup reconciliation: any queued/running record from a prior process is
  // a zombie -> failed+interrupted. NEVER auto-rerun. Then prune retention.
  reconcileZombieJobs();
  pruneJobs();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Connection', 'close');

      const method = req.method || 'GET';
      const url = (req.url || '').split('?')[0];

      if (method === 'POST' && url === '/claude-task') {
        handlePost(req, res);
        return;
      }
      if (method === 'GET' && url === '/health') {
        handleHealth(res);
        return;
      }
      if (method === 'GET' && url.startsWith('/claude-task/')) {
        const jobId = decodeURIComponent(url.slice('/claude-task/'.length));
        if (jobId) {
          handleGetJob(res, jobId);
          return;
        }
      }

      sendError(res, 404, 'NOT_FOUND', 'Not found');
    });

    server.keepAliveTimeout = 0;

    server.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({ err, port, host }, 'Claude task server failed to bind');
      reject(err);
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Claude task server started');
      resolve(server);
    });
  });
}
