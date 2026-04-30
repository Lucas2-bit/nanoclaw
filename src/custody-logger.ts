/**
 * PACT Custody Logger
 * ===================
 * Lightweight custody chain for build task delegation.
 * Structurally faithful to PACT protocol semantics without
 * the full cryptographic overhead (Ed25519 signing, hash-linking).
 *
 * Records: TRANSFER > VERIFY > COMPLETE/ROLLBACK
 *
 * Produces three key metrics:
 *  - Handoff completion rate
 *  - Verification pass rate
 *  - Rollback frequency
 *
 * Zero dependencies beyond Node.js stdlib.
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export type CustodyEventType = 'TRANSFER' | 'VERIFY' | 'COMPLETE' | 'ROLLBACK';

export interface CustodyEvent {
  id: string;
  task_id: string;
  type: CustodyEventType;
  ts: string;
  data: TransferData | VerifyData | CompleteData | RollbackData;
}

export interface TransferData {
  description: string;
  acceptance_criteria: string[];
  delegated_to: string;
  rollback_plan: string;
}

export interface VerifyData {
  result: 'pass' | 'fail';
  evidence: string[];
}

export interface CompleteData {
  outcome: string;
  duration_ms: number;
  token_cost_usd?: number;
}

export interface RollbackData {
  reason: string;
  reverted_to: string;
}

// ============================================================================
// Storage
// ============================================================================

const DATA_DIR = join(process.cwd(), 'data');
const CUSTODY_FILE = join(DATA_DIR, 'custody-chains.jsonl');

let dataReady = false;

async function ensureDataDir(): Promise<void> {
  if (dataReady) return;
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  dataReady = true;
}

async function appendEvent(event: CustodyEvent): Promise<void> {
  await ensureDataDir();
  const line = JSON.stringify(event) + '\n';
  await appendFile(CUSTODY_FILE, line, 'utf-8');
  logger.info({ task_id: event.task_id, type: event.type }, 'Custody event logged');
}

// ============================================================================
// API
// ============================================================================

/**
 * Generate a new task ID for a custody chain.
 */
export function newTaskId(): string {
  return `pact-task-${randomUUID().slice(0, 8)}`;
}

/**
 * Log a TRANSFER event - task is being handed off.
 */
export async function logTransfer(
  taskId: string,
  description: string,
  acceptanceCriteria: string[],
  delegatedTo: string,
  rollbackPlan: string,
): Promise<CustodyEvent> {
  const event: CustodyEvent = {
    id: `evt-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    type: 'TRANSFER',
    ts: new Date().toISOString(),
    data: {
      description,
      acceptance_criteria: acceptanceCriteria,
      delegated_to: delegatedTo,
      rollback_plan: rollbackPlan,
    },
  };
  await appendEvent(event);
  return event;
}

/**
 * Log a VERIFY event - output is being checked against criteria.
 */
export async function logVerify(
  taskId: string,
  result: 'pass' | 'fail',
  evidence: string[],
): Promise<CustodyEvent> {
  const event: CustodyEvent = {
    id: `evt-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    type: 'VERIFY',
    ts: new Date().toISOString(),
    data: { result, evidence },
  };
  await appendEvent(event);
  return event;
}

/**
 * Log a COMPLETE event - task finished successfully.
 */
export async function logComplete(
  taskId: string,
  outcome: string,
  durationMs: number,
  tokenCostUsd?: number,
): Promise<CustodyEvent> {
  const event: CustodyEvent = {
    id: `evt-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    type: 'COMPLETE',
    ts: new Date().toISOString(),
    data: { outcome, duration_ms: durationMs, token_cost_usd: tokenCostUsd },
  };
  await appendEvent(event);
  return event;
}

/**
 * Log a ROLLBACK event - task failed, reverting.
 */
export async function logRollback(
  taskId: string,
  reason: string,
  revertedTo: string,
): Promise<CustodyEvent> {
  const event: CustodyEvent = {
    id: `evt-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    type: 'ROLLBACK',
    ts: new Date().toISOString(),
    data: { reason, reverted_to: revertedTo },
  };
  await appendEvent(event);
  return event;
}

// ============================================================================
// Metrics
// ============================================================================

export interface CustodyMetrics {
  total_transfers: number;
  total_completions: number;
  total_rollbacks: number;
  total_verifications: number;
  verification_pass_rate: number;
  handoff_completion_rate: number;
  rollback_frequency: number;
}

/**
 * Calculate custody chain metrics from all recorded events.
 */
export async function getCustodyMetrics(): Promise<CustodyMetrics> {
  if (!existsSync(CUSTODY_FILE)) {
    return {
      total_transfers: 0,
      total_completions: 0,
      total_rollbacks: 0,
      total_verifications: 0,
      verification_pass_rate: 0,
      handoff_completion_rate: 0,
      rollback_frequency: 0,
    };
  }

  const content = await readFile(CUSTODY_FILE, 'utf-8');
  let transfers = 0;
  let completions = 0;
  let rollbacks = 0;
  let verifications = 0;
  let verifyPasses = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as CustodyEvent;
      switch (event.type) {
        case 'TRANSFER': transfers++; break;
        case 'COMPLETE': completions++; break;
        case 'ROLLBACK': rollbacks++; break;
        case 'VERIFY':
          verifications++;
          if ((event.data as VerifyData).result === 'pass') verifyPasses++;
          break;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    total_transfers: transfers,
    total_completions: completions,
    total_rollbacks: rollbacks,
    total_verifications: verifications,
    verification_pass_rate: verifications > 0 ? verifyPasses / verifications : 0,
    handoff_completion_rate: transfers > 0 ? completions / transfers : 0,
    rollback_frequency: transfers > 0 ? rollbacks / transfers : 0,
  };
}
