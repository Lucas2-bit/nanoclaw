/**
 * PACT Bridge - Host-side custody transfer router for NanoClaw
 *
 * Watches /workspace/ipc/{group}/custody/ directories for PACT envelopes,
 * routes them between agents, persists custody chains to store.
 *
 * This is middleware between the IPC filesystem and PACT core.
 * It does NOT replace existing IPC - it adds custody semantics alongside it.
 *
 * MVP: happy-path transfers only. No disputes, counter-proposals, or rollback.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

// --- Types ---

/** A PACT envelope as written to the filesystem by agents */
interface PACTEnvelope {
  pact_version: string;
  message_type: string;
  message_id: string;
  in_reply_to: string | null;
  session_id: string;
  timestamp: string;
  sender_id: string;
  signature: string;
  body: Record<string, unknown>;
}

/** Filesystem IPC wrapper around a PACT envelope */
interface CustodyIpcFile {
  type: 'custody_envelope';
  session_id: string;
  target_agent: string;
  target_group?: string;
  envelope: PACTEnvelope;
}

/** A persisted session record */
interface SessionIndex {
  session_id: string;
  ta_id: string;
  ra_id: string;
  ta_group: string;
  ra_group: string;
  state: string;
  created_at: string;
  updated_at: string;
  chain_file: string;
  message_count: number;
}

// --- Store paths ---

function getStoreDir(): string {
  return path.join(process.cwd(), 'store', 'custody-chains');
}

function getSessionIndexPath(): string {
  return path.join(getStoreDir(), '_index.json');
}

function getChainPath(sessionId: string): string {
  return path.join(getStoreDir(), `${sessionId}.json`);
}

function getInboxDir(groupFolder: string): string {
  return path.join(DATA_DIR, 'ipc', groupFolder, 'custody', 'inbox');
}

function getOutboxDir(groupFolder: string): string {
  return path.join(DATA_DIR, 'ipc', groupFolder, 'custody', 'outbox');
}

// --- Session index management ---

function loadSessionIndex(): Record<string, SessionIndex> {
  const indexPath = getSessionIndexPath();
  if (fs.existsSync(indexPath)) {
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch {
      logger.warn('Corrupted session index, starting fresh');
    }
  }
  return {};
}

function saveSessionIndex(index: Record<string, SessionIndex>): void {
  const indexPath = getSessionIndexPath();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

// --- Chain persistence ---

function loadChain(sessionId: string): PACTEnvelope[] {
  const chainPath = getChainPath(sessionId);
  if (fs.existsSync(chainPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
      return data.envelopes || [];
    } catch {
      logger.warn({ sessionId }, 'Corrupted chain file');
    }
  }
  return [];
}

function appendToChain(sessionId: string, envelope: PACTEnvelope): void {
  const chainPath = getChainPath(sessionId);
  const envelopes = loadChain(sessionId);
  envelopes.push(envelope);
  fs.writeFileSync(
    chainPath,
    JSON.stringify({ session_id: sessionId, envelopes, updated_at: new Date().toISOString() }, null, 2) + '\n',
  );
}

// --- State tracking ---

/** Derive session state from the latest message type */
function deriveState(messageType: string): string {
  const stateMap: Record<string, string> = {
    PACT_OFFER: 'OFFER_SENT',
    PACT_OFFER_RESPONSE: 'OFFER_RESPONDED',
    PACT_STATE_TRANSFER: 'STATE_TRANSFERRING',
    PACT_STATE_VERIFICATION: 'STATE_VERIFIED',
    PACT_ENTRY_STATE_RECORD: 'ENTRY_RECORDED',
    PACT_CUSTODY_PREPARE: 'PREPARING',
    PACT_CUSTODY_READY: 'READY',
    PACT_CUSTODY_COMMIT: 'COMMITTED',
    PACT_CUSTODY_ACKNOWLEDGE: 'EXECUTING',
    PACT_CHECKPOINT: 'EXECUTING',
    PACT_EXIT_STATE_RECORD: 'EXIT_RECORDED',
    PACT_COMPLETION_CONFIRM: 'COMPLETED',
    PACT_ERROR: 'ERROR',
  };
  return stateMap[messageType] || 'UNKNOWN';
}

function isTerminalState(state: string): boolean {
  return ['COMPLETED', 'ERROR', 'OFFER_REJECTED', 'ABORTED'].includes(state);
}

// --- Routing ---

/** Route an envelope to the target agent's inbox */
function deliverToAgent(
  targetGroup: string,
  envelope: PACTEnvelope,
  sessionId: string,
): void {
  const inboxDir = getInboxDir(targetGroup);
  fs.mkdirSync(inboxDir, { recursive: true });

  const filename = `${Date.now()}-${envelope.message_id.slice(-8)}.json`;
  const deliveryPayload: CustodyIpcFile = {
    type: 'custody_envelope',
    session_id: sessionId,
    target_agent: '', // Agent reads from their own inbox
    envelope,
  };

  fs.writeFileSync(
    path.join(inboxDir, filename),
    JSON.stringify(deliveryPayload, null, 2) + '\n',
  );
}

// --- Bridge dependencies ---

export interface PactBridgeDeps {
  registeredGroups: () => Record<string, { folder: string; isMain?: boolean }>;
}

// --- Main bridge loop ---

let bridgeRunning = false;

export function startPactBridge(deps: PactBridgeDeps): void {
  if (bridgeRunning) {
    logger.debug('PACT bridge already running');
    return;
  }
  bridgeRunning = true;

  // Ensure store directory exists
  const storeDir = getStoreDir();
  fs.mkdirSync(storeDir, { recursive: true });

  const processCustodyFiles = async () => {
    const ipcBaseDir = path.join(DATA_DIR, 'ipc');

    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
        } catch {
          return false;
        }
      });
    } catch {
      setTimeout(processCustodyFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    // Build agent-to-group lookup from session index
    const sessionIndex = loadSessionIndex();

    for (const sourceGroup of groupFolders) {
      const outboxDir = getOutboxDir(sourceGroup);
      if (!fs.existsSync(outboxDir)) continue;

      let files: string[];
      try {
        files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(outboxDir, file);
        try {
          const data: CustodyIpcFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

          if (data.type !== 'custody_envelope' || !data.envelope || !data.session_id) {
            logger.warn({ file, sourceGroup }, 'Invalid custody IPC file');
            fs.unlinkSync(filePath);
            continue;
          }

          const envelope = data.envelope;
          const sessionId = data.session_id;

          // Determine target group
          let targetGroup: string | undefined = data.target_group;

          if (!targetGroup) {
            // Look up from session index
            const session = sessionIndex[sessionId];
            if (session) {
              // Route to the other agent's group
              targetGroup = sourceGroup === session.ta_group
                ? session.ra_group
                : session.ta_group;
            }
          }

          // For new sessions (PACT_OFFER), register in index
          if (envelope.message_type === 'PACT_OFFER') {
            const raId = (envelope.body as { ra_agent_id?: string }).ra_agent_id;

            if (!targetGroup && raId) {
              // Default: target group is specified in the IPC file or we need it
              logger.warn({ sessionId, sourceGroup }, 'PACT_OFFER missing target_group');
              fs.unlinkSync(filePath);
              continue;
            }

            sessionIndex[sessionId] = {
              session_id: sessionId,
              ta_id: envelope.sender_id,
              ra_id: raId || 'unknown',
              ta_group: sourceGroup,
              ra_group: targetGroup!,
              state: 'OFFER_SENT',
              created_at: envelope.timestamp,
              updated_at: envelope.timestamp,
              chain_file: `${sessionId}.json`,
              message_count: 0,
            };
          }

          if (!targetGroup) {
            logger.warn({ sessionId, sourceGroup }, 'Cannot determine target group for custody envelope');
            fs.unlinkSync(filePath);
            continue;
          }

          // PACT envelopes are cryptographically signed, so cross-group
          // transfers are allowed for all groups (unlike unsigned IPC messages).
          // Signature verification happens at the protocol level.

          // Persist envelope to chain
          appendToChain(sessionId, envelope);

          // Update session index
          const session = sessionIndex[sessionId];
          if (session) {
            session.state = deriveState(envelope.message_type);
            session.updated_at = envelope.timestamp;
            session.message_count += 1;
          }

          // Route to target
          deliverToAgent(targetGroup, envelope, sessionId);

          logger.info(
            {
              sessionId: sessionId.slice(-12),
              type: envelope.message_type,
              from: sourceGroup,
              to: targetGroup,
            },
            'PACT envelope routed',
          );

          // Clean up processed file
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, sourceGroup, err }, 'Error processing custody file');
          const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(filePath, path.join(errorDir, `custody-${sourceGroup}-${file}`));
          } catch {
            // Best effort
          }
        }
      }
    }

    // Persist updated index
    saveSessionIndex(sessionIndex);

    setTimeout(processCustodyFiles, IPC_POLL_INTERVAL);
  };

  processCustodyFiles();
  logger.info('PACT custody bridge started');
}

// --- Query API (for agents to inspect custody state) ---

export function getSessionState(sessionId: string): SessionIndex | null {
  const index = loadSessionIndex();
  return index[sessionId] || null;
}

export function listSessions(filters?: {
  state?: string;
  agentId?: string;
  groupFolder?: string;
}): SessionIndex[] {
  const index = loadSessionIndex();
  let sessions = Object.values(index);

  if (filters?.state) {
    sessions = sessions.filter((s) => s.state === filters.state);
  }
  if (filters?.agentId) {
    sessions = sessions.filter((s) => s.ta_id === filters.agentId || s.ra_id === filters.agentId);
  }
  if (filters?.groupFolder) {
    sessions = sessions.filter((s) => s.ta_group === filters.groupFolder || s.ra_group === filters.groupFolder);
  }

  return sessions;
}

export function getChainForSession(sessionId: string): PACTEnvelope[] {
  return loadChain(sessionId);
}

/** Ensure custody directories exist for a group */
export function ensureCustodyDirs(groupFolder: string): void {
  fs.mkdirSync(getInboxDir(groupFolder), { recursive: true });
  fs.mkdirSync(getOutboxDir(groupFolder), { recursive: true });
}
