/**
 * Claude task job store — atomic file persistence for claude-task jobs.
 *
 * Jobs are persisted to ${DATA_DIR}/claude-tasks/<job_id>.json.
 * All writes are atomic: write to .tmp then rename.
 * Retention: keep most recent MAX_JOBS + age cap.
 * Never throws — all errors are logged and swallowed.
 */
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  CLAUDE_TASK_RETENTION_MAX,
  CLAUDE_TASK_RETENTION_AGE_MS,
} from './config.js';
import { logger } from './logger.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout';

export interface JobRecord {
  job_id: string;
  status: JobStatus;
  prompt: string;
  promptLength: number;
  timeoutMs: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  output?: string;
  stderr?: string;
  exitCode?: number | null;
  emptyOutput?: boolean;
  error?: string;
  errorCode?: string;
  interrupted?: boolean;
}

const STORE_DIR = () => path.join(DATA_DIR, 'claude-tasks');

function ensureDir(): void {
  try {
    fs.mkdirSync(STORE_DIR(), { recursive: true });
  } catch {
    // ignore
  }
}

/** Generate a job ID: timestamp + random hex, no external deps. */
export function generateJobId(): string {
  const ts = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `cj-${ts}-${rand}`;
}

/** Atomically write a job record (write tmp + rename). Never throws. */
export function writeJob(record: JobRecord): void {
  try {
    ensureDir();
    const dir = STORE_DIR();
    const file = path.join(dir, `${record.job_id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error(
      { err, job_id: record.job_id },
      'claude-task-store: writeJob failed',
    );
  }
}

/** Read a job record by ID. Returns null if not found or corrupt. Never throws. */
export function readJob(jobId: string): JobRecord | null {
  try {
    const file = path.join(STORE_DIR(), `${jobId}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

/**
 * On startup: find any jobs still in `queued` or `running` state and mark
 * them failed+interrupted. These are zombie jobs from a prior process.
 * NEVER auto-reruns them.
 */
export function reconcileZombieJobs(): void {
  try {
    ensureDir();
    const dir = STORE_DIR();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const file = path.join(dir, f);
        const raw = fs.readFileSync(file, 'utf8');
        const record = JSON.parse(raw) as JobRecord;
        if (record.status === 'queued' || record.status === 'running') {
          const updated: JobRecord = {
            ...record,
            status: 'failed',
            interrupted: true,
            finishedAt: new Date().toISOString(),
            error: 'Interrupted by process restart',
            errorCode: 'INTERRUPTED',
          };
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(updated), 'utf8');
          fs.renameSync(tmp, file);
          logger.warn(
            { job_id: record.job_id, priorStatus: record.status },
            'claude-task-store: zombie job marked failed+interrupted',
          );
        }
      } catch {
        // skip corrupt files
      }
    }
  } catch (err) {
    logger.error({ err }, 'claude-task-store: reconcileZombieJobs failed');
  }
}

/**
 * Prune old job files: keep only the most recent MAX_JOBS, and drop any
 * older than MAX_AGE_MS. Never throws.
 */
export function pruneJobs(): void {
  try {
    const dir = STORE_DIR();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return;

    // Collect mtimes
    const entries: { file: string; mtime: number }[] = [];
    for (const f of files) {
      try {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        entries.push({ file: full, mtime: stat.mtimeMs });
      } catch {
        // skip
      }
    }

    // Sort newest-first
    entries.sort((a, b) => b.mtime - a.mtime);

    const maxJobs = CLAUDE_TASK_RETENTION_MAX;
    const maxAgeMs = CLAUDE_TASK_RETENTION_AGE_MS;
    const now = Date.now();

    for (let i = 0; i < entries.length; i++) {
      const { file, mtime } = entries[i]!;
      const tooOld = now - mtime > maxAgeMs;
      const overCap = i >= maxJobs;
      if (tooOld || overCap) {
        try {
          fs.unlinkSync(file);
        } catch {
          // skip
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'claude-task-store: pruneJobs failed');
  }
}
