import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// --- config mock (shared across the file) -------------------------------
// MAX_QUEUE=2 lets us hold one active job + two queued (FIFO / QUEUE_FULL).
// SYNC_WAIT short so the sync-falls-back-to-async test is fast.
vi.mock('./config.js', () => ({
  CLAUDE_TASK_MAX_QUEUE: 2,
  CLAUDE_TASK_SYNC_WAIT_MS: 500,
}));

// --- logger mock --------------------------------------------------------
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- store mock: in-memory job map, sequential ids, no fs ---------------
vi.mock('./claude-task-store.js', () => {
  const jobs = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    generateJobId: () => `job-${++n}`,
    writeJob: (r: { job_id: string }) =>
      jobs.set(r.job_id, JSON.parse(JSON.stringify(r))),
    readJob: (id: string) => jobs.get(id) ?? null,
    reconcileZombieJobs: vi.fn(),
    pruneJobs: vi.fn(),
  };
});

// --- child_process mock: implementation set per-test after import -------
vi.mock('child_process', () => ({ spawn: vi.fn() }));

// A controllable fake ChildProcess (EventEmitter + emitter streams + kill).
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 4242;
  return proc;
}

type FakeProc = ReturnType<typeof createFakeProcess>;

let procs: FakeProc[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function waitForSpawnCount(
  spawn: ReturnType<typeof vi.fn>,
  count: number,
  timeoutMs = 2000,
): Promise<FakeProc> {
  const start = Date.now();
  while (spawn.mock.calls.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn not called ${count} time(s)`);
    }
    await delay(5);
  }
  return procs[count - 1]!;
}

// Fresh server + spawn impl per test (module state is reset between tests).
async function startServer(): Promise<{
  server: Server;
  base: string;
  spawn: ReturnType<typeof vi.fn>;
}> {
  const { startClaudeTaskServer } = await import('./claude-task-server.js');
  const cp = await import('child_process');
  const spawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;
  // The mock factory persists across resetModules, so the vi.fn accumulates
  // calls between tests — reset it (and re-set the impl) per server start.
  spawn.mockReset();
  spawn.mockImplementation(() => {
    const proc = createFakeProcess();
    procs.push(proc);
    return proc;
  });
  const server = await startClaudeTaskServer(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, spawn };
}

let activeServer: Server | null = null;

beforeEach(() => {
  vi.resetModules();
  procs = [];
});

afterEach(async () => {
  // Close any open child timers so the timeout/kill timers don't leak.
  for (const p of procs) {
    p.emit('close', 0);
  }
  if (activeServer) {
    await new Promise<void>((r) => activeServer!.close(() => r()));
    activeServer = null;
  }
});

describe('claude-task-server', () => {
  it('GET /health returns route-up + saturation shape', async () => {
    const { server, base } = await startServer();
    activeServer = server;

    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('up');
    expect(typeof json.version).toBe('string');
    expect(json.busy).toBe(false);
    expect(json.queueDepth).toBe(0);
    expect(json.activeJobId).toBe(null);
    expect(typeof json.uptimeMs).toBe('number');
  });

  it('GET unknown job -> 404 JOB_NOT_FOUND', async () => {
    const { server, base } = await startServer();
    activeServer = server;

    const res = await fetch(`${base}/claude-task/job-nope`);
    expect(res.status).toBe(404);
    const json = await readJson(res);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe('JOB_NOT_FOUND');
  });

  it('POST without prompt -> 400 MISSING_PROMPT', async () => {
    const { server, base } = await startServer();
    activeServer = server;

    const res = await fetch(`${base}/claude-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wait: false }),
    });
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.errorCode).toBe('MISSING_PROMPT');
  });

  it('POST with invalid JSON -> 400 INVALID_JSON', async () => {
    const { server, base } = await startServer();
    activeServer = server;

    const res = await fetch(`${base}/claude-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.errorCode).toBe('INVALID_JSON');
  });

  it('processes queued jobs in FIFO order (concurrency 1)', async () => {
    const { server, base, spawn } = await startServer();
    activeServer = server;

    const post = (prompt: string) =>
      fetch(`${base}/claude-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, wait: false }),
      });

    // A starts immediately (active); B and C queue behind it.
    expect((await post('A')).status).toBe(202);
    await waitForSpawnCount(spawn, 1);
    expect((await post('B')).status).toBe(202);
    expect((await post('C')).status).toBe(202);

    // Only A has spawned — concurrency is 1.
    await delay(20);
    expect(spawn.mock.calls.length).toBe(1);

    // Finish A -> B spawns; finish B -> C spawns.
    procs[0]!.emit('close', 0);
    await waitForSpawnCount(spawn, 2);
    procs[1]!.emit('close', 0);
    await waitForSpawnCount(spawn, 3);

    // The `-p <prompt>` arg of each spawn proves FIFO ordering.
    const prompts = spawn.mock.calls.map((c) => (c[1] as string[])[1]);
    expect(prompts).toEqual(['A', 'B', 'C']);
  });

  it('returns 429 QUEUE_FULL only when the queue is full', async () => {
    const { server, base, spawn } = await startServer();
    activeServer = server;

    const post = (prompt: string) =>
      fetch(`${base}/claude-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, wait: false }),
      });

    expect((await post('A')).status).toBe(202); // active
    await waitForSpawnCount(spawn, 1);
    expect((await post('B')).status).toBe(202); // queued (depth 1)
    expect((await post('C')).status).toBe(202); // queued (depth 2 == MAX)

    const full = await post('D'); // queue full
    expect(full.status).toBe(429);
    const json = await readJson(full);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe('QUEUE_FULL');
  });

  it('sets emptyOutput on exit 0 with empty stdout (sync)', async () => {
    const { server, base, spawn } = await startServer();
    activeServer = server;

    const p = fetch(`${base}/claude-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'noop', wait: true }),
    });

    const proc = await waitForSpawnCount(spawn, 1);
    proc.stdout.emit('data', Buffer.from('   \n')); // whitespace only
    proc.emit('close', 0);

    const res = await p;
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(json.emptyOutput).toBe(true);
    expect(json.output).toBe('');
    expect(typeof json.job_id).toBe('string');
  });

  it('sync long-poll falls back to 202 running on a slow task', async () => {
    const { server, base, spawn } = await startServer();
    activeServer = server;

    // wait omitted -> sync sugar; never close the child -> exceeds SYNC_WAIT.
    const res = await fetch(`${base}/claude-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'slow' }),
    });
    await waitForSpawnCount(spawn, 1);

    expect(res.status).toBe(202);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('running');
    expect(typeof json.job_id).toBe('string');
  });

  it('marks a job timeout and SIGTERMs the child on timeout', async () => {
    const { server, base, spawn } = await startServer();
    activeServer = server;

    const res = await fetch(`${base}/claude-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hang', timeout: 1000, wait: false }),
    });
    expect(res.status).toBe(202);
    const { job_id } = await readJson(res);

    const proc = await waitForSpawnCount(spawn, 1);

    // timeout clamps to a 1000ms floor; wait past it for the manual timer.
    await delay(1300);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    const jobRes = await fetch(`${base}/claude-task/${job_id}`);
    expect(jobRes.status).toBe(200);
    const job = await readJson(jobRes);
    expect(job.status).toBe('timeout');
    expect(job.errorCode).toBe('TIMEOUT');
  });
});
