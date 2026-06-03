import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  OPS_ALERT_JID,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import { startAlertConsumer } from './alert-consumer.js';
import { checkDistIntegrity, formatIntegrityMessage } from './integrity.js';
import { recordHealth } from './health.js';
import { writeAlertFile } from './safety/alert-writer.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startClaudeTaskServer } from './claude-task-server.js';
import { startCredentialProxy } from './credential-proxy.js';
import { CLAUDE_TASK_PORT, CREDENTIAL_PROXY_PORT } from './config.js';
import {
  getAllChats,
  getAllJidLinks,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  hasPendingCompact,
  initDatabase,
  linkJid,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  unlinkJid,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import type { ProcessResult } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { startPactBridge } from './pact-bridge.js';
import { initFormationHandler } from './formation-handler.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  routeOutbound,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startChannelHealthMonitor } from './channel-health.js';
import {
  observeContainerError,
  recordContainerSuccess,
  recordPromptStarted,
  startSilentDeathDetector,
} from './silent-death-detector.js';
import {
  recordSendFailure,
  startDeadLetterWorker,
} from './dead-letter-worker.js';
import { setOwnerPush } from './safety/outbound-guard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { getSessionFileSize, startSessionMonitor } from './session-monitor.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { parseImageReferences } from './image.js';
import { generateSpeech } from './tts.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// Export JID linking for IPC use
export { handleLinkJid, handleUnlinkJid };

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
/**
 * Per-JID cursor snapshot captured at the start of each processGroupMessages
 * run. Module-scope so the GroupQueue requeue callback can roll back cursors
 * from the hang-timeout path (which fires outside the run's local scope).
 */
const previousCursors: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// --- JID linking cache (channel unification) ---
// Maps secondary JID -> primary JID. Loaded at startup, invalidated on link/unlink.
let jidLinksCache: Map<string, string> = new Map();

function loadJidLinks(): void {
  jidLinksCache = new Map();
  for (const link of getAllJidLinks()) {
    jidLinksCache.set(link.secondary_jid, link.primary_jid);
  }
  if (jidLinksCache.size > 0) {
    logger.info({ linkCount: jidLinksCache.size }, 'JID links loaded');
  }
}

/**
 * Resolve a JID to its primary JID if linked, otherwise return the JID itself.
 */
function resolvePrimaryJid(jid: string): string {
  const primary = jidLinksCache.get(jid);
  if (primary) {
    logger.debug(
      { originalJid: jid, resolvedJid: primary },
      'JID resolved via link',
    );
    return primary;
  }
  return jid;
}

/**
 * Get all secondary JIDs that are linked to a given primary JID.
 */
function getSecondaryJids(primaryJid: string): string[] {
  const secondaries: string[] = [];
  for (const [secondary, primary] of jidLinksCache) {
    if (primary === primaryJid) secondaries.push(secondary);
  }
  return secondaries;
}

/**
 * Get all JIDs that should be polled: registered JIDs + linked secondary JIDs.
 */
function getAllPollableJids(): string[] {
  const registered = Object.keys(registeredGroups);
  const linked = [...jidLinksCache.keys()];
  return [...new Set([...registered, ...linked])];
}

/**
 * Route ops/liveness alert text (hang timeouts, silent-death) to the dedicated
 * OPS_ALERT_JID — but ONLY when it is configured AND a registered channel
 * actually owns that JID. Otherwise the alert is logged and dropped.
 *
 * This MUST NEVER fall back to the main user group chat: ops/liveness noise
 * leaking into the user's conversation was the bug this helper exists to fix.
 */
async function routeOpsAlert(text: string): Promise<void> {
  if (!OPS_ALERT_JID) {
    logger.warn({ text }, 'ops-alert: OPS_ALERT_JID not set — alert log-only');
    return;
  }
  const channel = findChannel(channels, OPS_ALERT_JID);
  if (!channel) {
    logger.warn(
      { jid: OPS_ALERT_JID, text },
      'ops-alert: no registered channel owns OPS_ALERT_JID — alert log-only',
    );
    return;
  }
  try {
    await channel.sendMessage(OPS_ALERT_JID, text);
  } catch (e) {
    logger.error(
      { e, jid: OPS_ALERT_JID },
      'ops-alert: send to OPS_ALERT_JID failed',
    );
  }
}

/**
 * Link a secondary JID to a primary JID (channel unification).
 * Persists to DB and updates in-memory cache.
 */
function handleLinkJid(secondaryJid: string, primaryJid: string): void {
  linkJid(secondaryJid, primaryJid);
  jidLinksCache.set(secondaryJid, primaryJid);
  logger.info({ secondaryJid, primaryJid }, 'JID linked');
}

/**
 * Unlink a secondary JID. Persists to DB and updates in-memory cache.
 */
function handleUnlinkJid(secondaryJid: string): void {
  unlinkJid(secondaryJid);
  jidLinksCache.delete(secondaryJid);
  logger.info({ secondaryJid }, 'JID unlinked');
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  loadJidLinks();
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      jidLinks: jidLinksCache.size,
    },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/**
 * Validate that every session in the DB has a corresponding JSONL file on disk.
 * Remove stale entries that point to archived or deleted session files.
 * This prevents "No conversation found with session ID" errors at container startup.
 */
const GHOST_MAX_BYTES = 1024;

/**
 * Check whether a session ID has a valid backing store (JSONL file OR directory).
 * Claude Code ≥ 4.x stores sessions as directories; older versions use .jsonl files.
 * Returns 'file' | 'dir' | 'stub' | 'missing'.
 */
function sessionBackingStatus(
  groupFolder: string,
  sessionId: string,
): 'file' | 'dir' | 'stub' | 'missing' {
  const base = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  const filePath = path.join(base, `${sessionId}.jsonl`);
  const dirPath = path.join(base, sessionId);

  if (fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size;
    return size < GHOST_MAX_BYTES ? 'stub' : 'file';
  }
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    return 'dir';
  }
  return 'missing';
}

function pruneStaleSessionIds(): void {
  let pruned = 0;
  for (const [groupFolder, sessionId] of Object.entries(sessions)) {
    if (!sessionId) continue;
    const status = sessionBackingStatus(groupFolder, sessionId);
    if (status === 'missing') {
      logger.warn(
        { groupFolder, sessionId, status },
        'Stale session ID: no backing file or directory, removing DB entry',
      );
      deleteSession(groupFolder);
      delete sessions[groupFolder];
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.info({ pruned }, 'Pruned stale session IDs on startup');
  }
}

function pruneOrphanSessionFiles(): void {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const knownSessionIds = new Set(Object.values(sessions));
  let removed = 0;
  let archived = 0;

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(sessionsDir).filter((f) => {
      try {
        return fs.statSync(path.join(sessionsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  for (const groupFolder of groupFolders) {
    const projectDir = path.join(
      sessionsDir,
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    if (!fs.existsSync(projectDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      if (knownSessionIds.has(sessionId)) continue;

      const filePath = path.join(projectDir, file);
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        continue;
      }

      if (sizeBytes <= GHOST_MAX_BYTES) {
        try {
          fs.unlinkSync(filePath);
          removed++;
          logger.info(
            { groupFolder, sessionId, sizeBytes },
            'Removed ghost session file (orphaned, under 1 KB)',
          );
        } catch (err) {
          logger.warn(
            { err, groupFolder, sessionId },
            'Failed to remove ghost session file',
          );
        }
      } else {
        const archiveDir = path.join(DATA_DIR, 'session-archive', groupFolder);
        try {
          fs.mkdirSync(archiveDir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveName = `orphan_${sessionId}_${timestamp}.jsonl`;
          fs.renameSync(filePath, path.join(archiveDir, archiveName));
          archived++;
          logger.warn(
            { groupFolder, sessionId, sizeBytes, archiveName },
            'Archived orphan session file (not in DB, over 1 KB)',
          );
        } catch (err) {
          logger.warn(
            { err, groupFolder, sessionId },
            'Failed to archive orphan session file',
          );
        }
      }
    }
  }

  if (removed > 0 || archived > 0) {
    logger.info({ removed, archived }, 'Orphan session cleanup complete');
  }
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<ProcessResult> {
  // Resolve linked JIDs: chatJid may be a secondary that maps to a primary group
  const primaryJid = resolvePrimaryJid(chatJid);
  // Snapshot the run generation at entry — if it advances mid-run (timeout
  // path superseded us, or a fresh run started), we must NOT roll back the
  // cursor because the timeout path now owns requeue.
  const myGen = queue.getGeneration(primaryJid);
  const group = registeredGroups[primaryJid];
  if (!group) return { ok: true, ranToCompletion: false };

  // Collect messages from the primary JID AND all linked secondary JIDs.
  // Messages are stored under their original JID, so we must check all of them.
  const allJids = [primaryJid, ...getSecondaryJids(primaryJid)];
  let missedMessages: NewMessage[] = [];
  let activeChannel: Channel | undefined;
  let activeChatJid = chatJid; // the JID whose channel we'll reply through

  for (const jid of allJids) {
    const msgs = getMessagesSince(
      jid,
      getOrRecoverCursor(jid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (msgs.length > 0) {
      missedMessages.push(...msgs);
      // Use the channel of the JID that actually has messages for replies
      const ch = findChannel(channels, jid);
      if (ch) {
        activeChannel = ch;
        activeChatJid = jid;
      }
    }
  }

  // Sort by timestamp in case messages came from multiple channels
  missedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Trim to max
  if (missedMessages.length > MAX_MESSAGES_PER_PROMPT) {
    missedMessages = missedMessages.slice(-MAX_MESSAGES_PER_PROMPT);
  }

  const hasVoiceInput = missedMessages.some(
    (m) => m.content.startsWith('[Voice:') && !m.is_from_me,
  );

  const channel = activeChannel || findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return { ok: true, ranToCompletion: false };
  }

  const isMainGroup = group.isMain === true;

  if (missedMessages.length === 0) return { ok: true, ranToCompletion: false };

  // --- Session command interception (before trigger check) ---
  const isPrivateChat = !isMainGroup && group.requiresTrigger === false;
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    isPrivateChat,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(activeChatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(activeChatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, activeChatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(primaryJid),
      advanceCursor: (ts) => {
        // Advance cursor for ALL linked JIDs so messages aren't re-fetched
        for (const jid of allJids) {
          lastAgentTimestamp[jid] = ts;
        }
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(
                activeChatJid,
                msg.sender,
                loadSenderAllowlist(),
              )))
        );
      },
    },
  });
  if (cmdResult.handled)
    return { ok: cmdResult.success, ranToCompletion: false };
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me ||
          isTriggerAllowed(activeChatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return { ok: true, ranToCompletion: false };
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor for ALL linked JIDs so messages aren't re-fetched.
  // previousCursors is module-scope (see top of file) so the queue's requeue
  // callback can roll back from the hang-timeout path.
  const lastTs = missedMessages[missedMessages.length - 1].timestamp;
  for (const jid of allJids) {
    previousCursors[jid] = lastAgentTimestamp[jid] || '';
    lastAgentTimestamp[jid] = lastTs;
  }

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(primaryJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(activeChatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    activeChatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.status === 'keepalive') {
        resetIdleTimer();
        return;
      }
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          let delivered = false;
          try {
            delivered = await channel.sendMessage(activeChatJid, text);
          } catch (err) {
            recordSendFailure(activeChatJid, text, group.folder, err);
            throw err; // re-throw so the caller still sees the error
          }
          // Only advance cursor + fire TTS follow-up when the user actually
          // received the text. A HELD/suppressed send (allergen backstop,
          // dedupe, queued-while-disconnected) returns false; treating it
          // as success would drop the next inbound and TTS-speak text the
          // user never saw.
          if (delivered) {
            outputSentToUser = true;
            // Persist cursor now that output was confirmed sent to user
            saveState();

            // Voice response: if input had voice messages and channel supports it, send TTS
            if (hasVoiceInput && channel.sendVoiceNote && group.voiceEnabled) {
              try {
                const audioBuffer = await generateSpeech(text);
                if (audioBuffer) {
                  await channel.sendVoiceNote(activeChatJid, audioBuffer);
                  logger.info(
                    { group: group.name, bytes: audioBuffer.length },
                    'Voice note response sent',
                  );
                }
              } catch (ttsErr) {
                logger.warn(
                  { err: ttsErr },
                  'TTS voice response failed - text was sent',
                );
              }
            }
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(primaryJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(activeChatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      // Output was delivered end-to-end before the error, so this counts as a
      // genuine completion for the D1 alarm.
      return { ok: true, ranToCompletion: true };
    }
    if (queue.getGeneration(primaryJid) !== myGen) {
      logger.info(
        { jid: primaryJid },
        'Run superseded by timeout/new run; skipping cursor rollback',
      );
      return { ok: false, ranToCompletion: false };
    }
    // Roll back cursors for all linked JIDs so retries can re-process
    for (const jid of allJids) {
      lastAgentTimestamp[jid] = previousCursors[jid] || '';
    }
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return { ok: false, ranToCompletion: false };
  }

  // Agent completed successfully. Persist cursor if not already saved.
  if (!outputSentToUser) {
    saveState();
  }

  // Genuine end-to-end completion: a container spawned and delivered output.
  return { ok: true, ranToCompletion: true };
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  // Count a prompt-start for the silent-death detector. Wrapped at the
  // helper layer so a detector failure can never reach the message path.
  recordPromptStarted();
  const isMain = group.isMain === true;
  let sessionId: string | undefined = sessions[group.folder];

  // Runtime validation: verify session backing store exists before passing to container.
  // Handles both old .jsonl format and new directory-based format (Claude Code ≥ 4.x).
  // pruneStaleSessionIds() only runs at startup; this catches mid-run stales.
  if (sessionId) {
    const status = sessionBackingStatus(group.folder, sessionId);
    if (status === 'missing' || status === 'stub') {
      logger.warn(
        { groupFolder: group.folder, sessionId, status },
        'Stale session detected at runtime -- clearing before container launch',
      );
      deleteSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
    }
  }
  // Use primaryJid for queue registration so serialization is consistent
  const queueJid = resolvePrimaryJid(chatJid);
  // Determine which channel this message came from
  const sourceChannel = findChannel(channels, chatJid)?.name;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results.
  // Only register newSessionId on success — error outputs re-emit the stale ID
  // (from the agent-runner catch block) which would poison the DB and cause the
  // next retry to also fail with "No conversation found".
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && output.status !== 'error') {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Pre-flight: if session file is near the critical threshold, inject
  // /compact instead of the user prompt to prevent OOM during the run.
  const PRE_FLIGHT_THRESHOLD = 2.5 * 1024 * 1024; // 2.5 MB — triggers before the 3 MB critical
  const sessionSize = getSessionFileSize(group.folder, sessionId);
  if (sessionSize > PRE_FLIGHT_THRESHOLD) {
    logger.warn(
      {
        groupFolder: group.folder,
        sessionSizeKB: Math.round(sessionSize / 1024),
      },
      'runAgent: session file near limit — injecting /compact before user prompt',
    );
    prompt = `/compact\n\nAfter compacting, process this original message:\n${prompt}`;
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
        ...(sourceChannel && { sourceChannel }),
      },
      (proc, containerName) =>
        queue.registerProcess(queueJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && output.status !== 'error') {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      observeContainerError(output.error);
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    recordContainerSuccess();
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      // Include linked secondary JIDs in the poll so their messages are fetched
      const jids = getAllPollableJids();
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by resolved primary JID so linked channels merge
        // into one group entry. Track the original chatJid for each message
        // so replies go back through the correct channel.
        const messagesByGroup = new Map<
          string,
          { chatJid: string; messages: NewMessage[] }[]
        >();
        for (const msg of messages) {
          const primaryJid = resolvePrimaryJid(msg.chat_jid);
          const entries = messagesByGroup.get(primaryJid) || [];
          // Find existing entry for this specific chatJid (channel)
          let entry = entries.find((e) => e.chatJid === msg.chat_jid);
          if (!entry) {
            entry = { chatJid: msg.chat_jid, messages: [] };
            entries.push(entry);
          }
          entry.messages.push(msg);
          messagesByGroup.set(primaryJid, entries);
        }

        for (const [primaryJid, channelEntries] of messagesByGroup) {
          const group = registeredGroups[primaryJid];
          if (!group) continue;

          // Use the first channel that has messages for routing
          // (in practice, a single poll cycle usually has messages from one channel)
          const firstEntry = channelEntries[0];
          const chatJid = firstEntry.chatJid;
          const groupMessages = channelEntries.flatMap((e) => e.messages);

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            const isPrivateChatLoop =
              !isMainGroup && group.requiresTrigger === false;
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
                isPrivateChatLoop,
              )
            ) {
              queue.closeStdin(primaryJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(primaryJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Use primaryJid for queue operations (serialization) but chatJid for outbound
          if (queue.sendMessage(primaryJid, formatted)) {
            logger.debug(
              { chatJid, primaryJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(primaryJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Check registered groups
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
  // Also check linked secondary JIDs for unprocessed messages
  for (const [secondaryJid, primaryJid] of jidLinksCache) {
    const pending = getMessagesSince(
      secondaryJid,
      getOrRecoverCursor(secondaryJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { secondaryJid, primaryJid, pendingCount: pending.length },
        'Recovery: found unprocessed messages on linked JID',
      );
      queue.enqueueMessageCheck(primaryJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Git-integrity check: non-blocking, advisory-or-drift only. We never gate
  // `ready` on this — a drifted dist is degraded, not dead, and the alert
  // path is enough to get attention without preventing boot.
  try {
    const integ = checkDistIntegrity();
    recordHealth('distIntegrity', integ);
    if (!integ.ok) {
      logger.error({ reasons: integ.reasons }, 'dist integrity drift at boot');
      writeAlertFile(formatIntegrityMessage(integ), 'git-integrity');
    }
    // Drop a "this process is alive on THIS sha" beacon for scripts/deploy.sh
    // post-verify. The file's gitSha is what the live process actually loaded
    // (via integrity.ts → dist/build-info.json), and the pid lets deploy.sh
    // distinguish a successful re-exec from a stale carry-over. Best-effort:
    // a failure here must never crash boot.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'running.json'),
        JSON.stringify({
          pid: process.pid,
          gitSha: integ.details.buildSha ?? null,
          headSha: integ.details.headSha ?? null,
          builtAt: integ.details.builtAt ?? null,
          startedAt: new Date().toISOString(),
        }),
        'utf-8',
      );
    } catch (e) {
      logger.warn({ err: e }, 'failed to write running.json (non-fatal)');
    }
  } catch (e) {
    logger.error({ err: e }, 'integrity check threw (ignored, non-blocking)');
  }

  loadState();
  pruneStaleSessionIds();
  pruneOrphanSessionFiles();
  logger.info('Stale sessions pruned');
  startAlertConsumer();

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start Claude task server (Ulterior uses this to run host tasks via HTTP)
  const taskServer = await startClaudeTaskServer(
    CLAUDE_TASK_PORT,
    PROXY_BIND_HOST,
  );

  // Signal pm2 that we have successfully bound the port and are ready.
  // Requires wait_ready: true in ecosystem.config.cjs. pm2 will not
  // start a new instance until the old one is fully dead, preventing
  // EADDRINUSE race conditions.
  if (typeof process.send === 'function') {
    process.send('ready');
    logger.info('Sent ready signal to pm2');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Force-close all keep-alive connections so port 3001 is released
    // immediately. Without this, in-flight keep-alive connections hold the
    // socket open and the next process start gets EADDRINUSE.
    proxyServer.closeAllConnections();
    proxyServer.close();
    taskServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Wire owner-push for the outbound allergen guard. On HOLD, the guard
  // calls this to send a separate visible flag to the main group (Lucas)
  // IN ADDITION to delivering the original message. Plain allergen-free
  // text so the guard's screener never holds the flag itself.
  setOwnerPush(async (text) => {
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain === true,
    );
    if (!mainEntry) {
      logger.warn('outbound-guard: no main group; owner flag only logged');
      return;
    }
    await routeOutbound(channels, mainEntry[0], text);
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    resolvePrimaryJid,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        try {
          await channel.sendMessage(jid, text);
        } catch (err) {
          const groupFolder = registeredGroups[jid]?.folder ?? null;
          recordSendFailure(jid, text, groupFolder, err);
        }
      }
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const delivered = await channel.sendMessage(jid, text);

      // TTS: only follow up with a voice note if the user actually saw
      // the text. A HELD send returns false; speaking the suppressed text
      // would leak it through audio (C-1).
      if (delivered && channel.sendVoiceNote) {
        try {
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const recentMsgs = getMessagesSince(jid, fiveMinAgo, '__bot__', 20);
          const hasVoice = recentMsgs.some(
            (m) => m.content.startsWith('[Voice:') && !m.is_from_me,
          );
          if (hasVoice) {
            const audioBuffer = await generateSpeech(text);
            if (audioBuffer) {
              await channel.sendVoiceNote(jid, audioBuffer);
              logger.info(
                { jid, bytes: audioBuffer.length },
                'TTS voice note sent via IPC',
              );
            }
          }
        } catch (ttsErr) {
          logger.warn(
            { err: ttsErr, jid },
            'TTS voice note failed - text was sent',
          );
        }
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    linkJid: handleLinkJid,
    unlinkJid: handleUnlinkJid,
  });
  startPactBridge({
    registeredGroups: () => registeredGroups,
  });
  initFormationHandler();
  queue.setProcessMessagesFn(processGroupMessages);
  // Hang-timeout / D1-D2 alerts are ops/liveness noise — route them to the
  // dedicated OPS_ALERT_JID (or log-only), NEVER to the main user chat.
  queue.setNotifyMainFn(routeOpsAlert);
  queue.setRequeueFn((primaryJid) => {
    const jids = [primaryJid, ...getSecondaryJids(primaryJid)];
    for (const jid of jids) {
      lastAgentTimestamp[jid] = previousCursors[jid] || '';
    }
    saveState();
    logger.info(
      { jid: primaryJid },
      'Hang timeout: cursor rolled back for requeue',
    );
  });
  recoverPendingMessages();

  // Start the independent heartbeat tick so the supervisor can detect event-loop hangs.
  queue.startHeartbeatTick();

  // Start session file size monitor (Fix 1 — OOM prevention, with auto-compact)
  startSessionMonitor(
    () => registeredGroups,
    (groupFolder: string) => {
      // registeredGroups is keyed by JID — find the entry whose folder matches.
      const entry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === groupFolder,
      );
      if (!entry) {
        logger.warn(
          { groupFolder },
          'auto-compact: group not found in registeredGroups',
        );
        return;
      }
      const [jid] = entry;
      // Dedup: skip if there's already a pending /compact in the queue
      if (hasPendingCompact(jid, ASSISTANT_NAME)) {
        logger.info(
          { groupFolder, jid },
          'auto-compact: skipped — /compact already pending in queue',
        );
        return;
      }
      // Inject a synthetic /compact message as if sent by the session owner.
      // is_from_me=true is required for session command authorisation checks.
      storeMessageDirect({
        id: `auto-compact-${Date.now()}`,
        chat_jid: jid,
        sender: jid,
        sender_name: 'system',
        content: '/compact',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: false,
      });
      // Wake the message loop to process the injected command.
      queue.enqueueMessageCheck(jid);
      logger.info(
        { groupFolder, jid },
        'auto-compact: /compact injected into message queue',
      );
    },
    // Hard ceiling callback: clear in-memory session after archive-and-reset
    (groupFolder: string) => {
      delete sessions[groupFolder];
      logger.info(
        { groupFolder },
        'session-monitor: in-memory session cleared after hard reset',
      );
    },
    // In-flight predicate: defer archive-and-reset while ANY JID mapping to
    // this folder has a container run active. OR across all matches so a
    // run on a linked secondary JID still protects the shared session.
    (groupFolder: string): boolean => {
      for (const [jid, g] of Object.entries(registeredGroups)) {
        if (g.folder !== groupFolder) continue;
        if (queue.isActive(resolvePrimaryJid(jid))) return true;
      }
      return false;
    },
  );

  // Start channel health monitor (Fix 2 — silent disconnect detection)
  startChannelHealthMonitor(() => channels);

  // Start silent-death detector: alarms when prompts arrive but zero
  // container runs succeed within a rolling window. This is ops/liveness
  // noise, so it routes to the dedicated OPS_ALERT_JID (or log-only) via
  // routeOpsAlert and MUST NEVER leak into the main user chat.
  startSilentDeathDetector(routeOpsAlert);

  // Start dead letter queue retry worker (Fix 4 — outbound message recovery)
  startDeadLetterWorker(async (jid, text) => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    await channel.sendMessage(jid, text);
  });

  startMessageLoop().catch((err) => {
    logger.fatal(
      { err },
      'Message loop crashed unexpectedly — writing supervisor signal for restart',
    );
    // MF1 class (a) neuter: write supervisor signal instead of silent exit.
    // Supervisor reads this and issues a bounded restart + e2e probe.
    // process.exit still fires as fallback if supervisor is unavailable.
    const _sigPath = path.join(DATA_DIR, 'supervisor-signal.json');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        _sigPath + '.tmp',
        JSON.stringify({
          ts: Date.now(),
          reason: 'message-loop-crash',
          pid: process.pid,
        }),
      );
      fs.renameSync(_sigPath + '.tmp', _sigPath);
    } catch (_e) {
      /* non-fatal */
    }
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
