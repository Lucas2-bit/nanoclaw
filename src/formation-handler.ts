/**
 * Formation Handler - NanoClaw Host-Side Formation Integration
 *
 * Tracks formation state for users across groups. When a user starts formation,
 * their messages are routed through the Parago formation engine (inside the
 * container) rather than normal agent processing.
 *
 * This module:
 * 1. Detects /form command to start formation
 * 2. Tracks active formation sessions per user
 * 3. Exposes formation state for the dashboard
 * 4. Manages formation lifecycle (start, progress, complete)
 *
 * Integration with NanoClaw:
 *   The formation engine runs inside the container via formation-cli.ts.
 *   This handler tells the container agent (via system prompt injection)
 *   whether the user is in an active formation session, so the agent
 *   knows to delegate to the formation CLI.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ============================================================
// Types
// ============================================================

export interface FormationSession {
  userId: string;
  userName: string;
  chatJid: string;
  groupFolder: string;
  channel: string;
  startedAt: string;
  lastActivity: string;
  phase: string;
  confidence: number;
  domainsAssessed: number;
  totalDomains: number;
  turnCount: number;
  status: 'active' | 'paused' | 'completed';
}

interface FormationIndex {
  sessions: Record<string, FormationSession>;
  updatedAt: string;
}

// ============================================================
// State
// ============================================================

const FORMATION_DIR = path.join(DATA_DIR, 'formation');
const INDEX_FILE = path.join(FORMATION_DIR, 'index.json');

let formationIndex: FormationIndex = { sessions: {}, updatedAt: '' };

// ============================================================
// Persistence
// ============================================================

function loadIndex(): void {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      formationIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch {
    logger.warn('Corrupted formation index, resetting');
    formationIndex = { sessions: {}, updatedAt: '' };
  }
}

function saveIndex(): void {
  fs.mkdirSync(FORMATION_DIR, { recursive: true });
  formationIndex.updatedAt = new Date().toISOString();
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(formationIndex, null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

// ============================================================
// Session management
// ============================================================

/**
 * Start or resume a formation session for a user.
 */
export function startFormation(
  userId: string,
  userName: string,
  chatJid: string,
  groupFolder: string,
  channel: string,
): FormationSession {
  loadIndex();

  const existing = formationIndex.sessions[userId];
  if (existing && existing.status === 'active') {
    logger.info({ userId }, 'Formation already active, resuming');
    return existing;
  }

  const session: FormationSession = {
    userId,
    userName,
    chatJid,
    groupFolder,
    channel,
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    phase: 'consent',
    confidence: 0,
    domainsAssessed: 0,
    totalDomains: 14,
    turnCount: 0,
    status: 'active',
  };

  formationIndex.sessions[userId] = session;
  saveIndex();

  logger.info({ userId, userName, chatJid }, 'Formation session started');
  return session;
}

/**
 * Update formation session state from CLI output.
 */
export function updateFormation(
  userId: string,
  update: Partial<Pick<FormationSession, 'phase' | 'confidence' | 'domainsAssessed' | 'turnCount' | 'status'>>,
): FormationSession | null {
  loadIndex();

  const session = formationIndex.sessions[userId];
  if (!session) return null;

  if (update.phase !== undefined) session.phase = update.phase;
  if (update.confidence !== undefined) session.confidence = update.confidence;
  if (update.domainsAssessed !== undefined) session.domainsAssessed = update.domainsAssessed;
  if (update.turnCount !== undefined) session.turnCount = update.turnCount;
  if (update.status !== undefined) session.status = update.status;
  session.lastActivity = new Date().toISOString();

  saveIndex();
  return session;
}

/**
 * Check if a user has an active formation session.
 */
export function isFormationActive(userId: string): boolean {
  loadIndex();
  const session = formationIndex.sessions[userId];
  return session?.status === 'active';
}

/**
 * Get a user's formation session.
 */
export function getFormationSession(userId: string): FormationSession | null {
  loadIndex();
  return formationIndex.sessions[userId] || null;
}

/**
 * Get all formation sessions (for dashboard).
 */
export function getAllFormationSessions(): FormationSession[] {
  loadIndex();
  return Object.values(formationIndex.sessions);
}

/**
 * Get formation stats (for dashboard).
 */
export function getFormationStats(): {
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  averageConfidence: number;
} {
  loadIndex();
  const sessions = Object.values(formationIndex.sessions);
  const active = sessions.filter(s => s.status === 'active');
  const completed = sessions.filter(s => s.status === 'completed');
  const avgConf = sessions.length > 0
    ? sessions.reduce((sum, s) => sum + s.confidence, 0) / sessions.length
    : 0;

  return {
    totalSessions: sessions.length,
    activeSessions: active.length,
    completedSessions: completed.length,
    averageConfidence: Math.round(avgConf * 100) / 100,
  };
}

// ============================================================
// System prompt injection
// ============================================================

/**
 * Generate the system prompt block that tells the agent about formation state.
 * Injected into the container agent's system prompt when formation is active.
 */
export function getFormationPromptBlock(userId: string, userName: string): string | null {
  loadIndex();
  const session = formationIndex.sessions[userId];
  if (!session || session.status !== 'active') return null;

  return `<formation-active>
This user (${userName}) has an active Parago formation session.
Phase: ${session.phase} | Confidence: ${Math.round(session.confidence * 100)}% | Turn: ${session.turnCount}

IMPORTANT: Route this user's messages through the formation engine.
Run: npx tsx /workspace/group/ventures/altego/formation-cli.ts message "${userId}" "${session.channel}" "<their message>"

Parse the JSON output and send the "reply" field back to the user.
Do NOT add your own commentary - the formation engine handles the conversation.

If they send /status, /mirror, /pause, /skip - pass those through too.
If they say something clearly not formation-related (e.g., asking you a direct question about work),
respond normally but note the formation is still active in the background.
</formation-active>`;
}

/**
 * Detect formation triggers in a message.
 * Returns true if the message should start formation.
 */
export function isFormationTrigger(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === '/form' ||
    lower === '/formation' ||
    lower === '/parago' ||
    lower.startsWith('/form ') ||
    lower === 'start formation';
}

// ============================================================
// Init
// ============================================================

export function initFormationHandler(): void {
  fs.mkdirSync(FORMATION_DIR, { recursive: true });
  loadIndex();
  const active = Object.values(formationIndex.sessions).filter(s => s.status === 'active');
  logger.info(
    { totalSessions: Object.keys(formationIndex.sessions).length, activeSessions: active.length },
    'Formation handler initialised',
  );
}
