import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY,
      group_folder TEXT,
      chat_jid TEXT,
      content TEXT,
      failed_at TEXT,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      resolved INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dlq_resolved ON dead_letter_queue(resolved);
    -- RISK-013 Chunk 3 — outbound-send content hashes for dedup suppression.
    -- Records the (groupJid, normalizedText, bucket) hash of every genuinely
    -- delivered outbound send; lookup on future sends catches verbatim repeats
    -- within a rolling 120-min window (see 15min bucket + 8-bucket lookback
    -- in checkOutboundDedup). sent_at is ms epoch of the confirmed send.
    -- Index on sent_at is for the opportunistic TTL cleanup query, not the
    -- primary dedup lookup (which hits the primary-key hash directly).
    CREATE TABLE IF NOT EXISTS outbound_hashes (
      hash TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_hashes_sent_at ON outbound_hashes(sent_at);
    -- RISK-013 Chunk 5b — INBOUND-side dedup backstop. Records hash of every
    -- fully-processed batch (at outputSentToUser=true). Retries of an already-
    -- answered batch (hang/kill/retry-storm) hit the check gate BEFORE runAgent
    -- and skip the entire container spawn — catches the Jul-8 00:48-style
    -- pattern (duplicated inbound, distinct outbound each time) that Chunk 3's
    -- outbound-hash dedup cannot see. See specs/risk-013-chunk5-inbound-dedup-v7.md.
    CREATE TABLE IF NOT EXISTS inbound_processed_hashes (
      hash TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_processed_hashes_processed_at ON inbound_processed_hashes(processed_at);

    CREATE TABLE IF NOT EXISTS jid_links (
      secondary_jid TEXT PRIMARY KEY,
      primary_jid TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add hold_type column to dead_letter_queue if it doesn't exist (RISK-013
  // Chunk 2). NULL = normal dead-letter entry, eligible for the
  // dead-letter-worker.ts auto-resend loop (unchanged behavior for real
  // send failures). 'oversize_manual' = parked by the oversize-batch guard
  // in startMessageLoop; auto-resend MUST skip these until a human
  // explicitly releases the hold via releaseOversizeHold().
  try {
    database.exec(
      `ALTER TABLE dead_letter_queue ADD COLUMN hold_type TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

/**
 * Check if there is already a pending /compact message for a given JID
 * that was injected after the last bot response.
 */
export function hasPendingCompact(chatJid: string, botPrefix: string): boolean {
  const lastBot = getLastBotMessageTimestamp(chatJid, botPrefix);
  const sinceTs = lastBot ?? '';
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND content = '/compact' AND is_from_me = 1
         AND timestamp > ?
       LIMIT 1`,
    )
    .get(chatJid, sinceTs) as Record<string, unknown> | undefined;
  return row !== undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Dead Letter Queue accessors ---

export interface DeadLetterEntry {
  id: string;
  group_folder: string | null;
  chat_jid: string | null;
  content: string | null;
  failed_at: string;
  retry_count: number;
  last_error: string | null;
  /** 0 = pending retry, 1 = resolved (sent successfully), -1 = permanently failed */
  resolved: number;
  /**
   * NULL = normal send-failure entry, eligible for dead-letter-worker.ts's
   * automatic resend loop. 'oversize_manual' = parked by the oversize-batch
   * guard in src/index.ts startMessageLoop (RISK-013 Chunk 2); excluded from
   * auto-resend until a human clears it via releaseOversizeHold(). Blindly
   * auto-resending an oversized batch would replay the exact content that
   * caused the original hang — the manual gate is intentional.
   */
  hold_type: 'oversize_manual' | null;
}

/**
 * Insert a failed outbound message into the dead letter queue.
 *
 * `hold_type` defaults to null for genuine send failures (unchanged behavior
 * from before RISK-013 Chunk 2 — dead-letter-worker.ts's auto-resend loop
 * still processes these on its next tick). Pass 'oversize_manual' to park a
 * batch that must not be auto-resent (e.g. the oversize-batch guard in
 * startMessageLoop).
 */
export function insertDeadLetter(
  entry: Omit<DeadLetterEntry, 'retry_count' | 'resolved' | 'hold_type'> & {
    hold_type?: DeadLetterEntry['hold_type'];
  },
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO dead_letter_queue (id, group_folder, chat_jid, content, failed_at, retry_count, last_error, resolved, hold_type)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)
  `,
  ).run(
    entry.id,
    entry.group_folder,
    entry.chat_jid,
    entry.content,
    entry.failed_at,
    entry.last_error,
    entry.hold_type ?? null,
  );
}

/**
 * Return all unresolved dead letter entries with retry_count < maxRetries,
 * ordered oldest-first. Entries with a non-null `hold_type` (e.g.
 * 'oversize_manual') are EXCLUDED — the dead-letter-worker.ts auto-resend
 * loop must never touch them; they wait for an explicit releaseOversizeHold()
 * call.
 */
export function getPendingDeadLetters(maxRetries: number): DeadLetterEntry[] {
  return db
    .prepare(
      `
    SELECT * FROM dead_letter_queue
    WHERE resolved = 0 AND retry_count < ? AND hold_type IS NULL
    ORDER BY failed_at
  `,
    )
    .all(maxRetries) as DeadLetterEntry[];
}

/**
 * Release an 'oversize_manual' hold so the entry becomes eligible for the
 * normal dead-letter-worker.ts auto-resend loop on its next tick. Call this
 * ONLY after a human has confirmed the parked batch is safe to attempt —
 * reviewed, still relevant, and not itself liable to reproduce the original
 * hang. This is the explicit manual-clearance gate RISK-013 Chunk 2 requires;
 * nothing calls this automatically.
 */
export function releaseOversizeHold(id: string): void {
  db.prepare(`UPDATE dead_letter_queue SET hold_type = NULL WHERE id = ?`).run(
    id,
  );
}

/**
 * Increment the retry count and update the last error for a dead letter entry.
 */
export function updateDeadLetterRetry(id: string, lastError: string): void {
  db.prepare(
    `
    UPDATE dead_letter_queue SET retry_count = retry_count + 1, last_error = ? WHERE id = ?
  `,
  ).run(lastError, id);
}

/**
 * Mark a dead letter entry as resolved.
 * Pass resolved = 1 for success, -1 for permanent failure.
 */
export function resolveDeadLetter(id: string, resolved: 1 | -1): void {
  db.prepare(`UPDATE dead_letter_queue SET resolved = ? WHERE id = ?`).run(
    resolved,
    id,
  );
}

/**
 * Return all dead letter queue entries (for health reporting / Ulterior).
 */
export function getDeadLetterQueue(): DeadLetterEntry[] {
  return db
    .prepare(`SELECT * FROM dead_letter_queue ORDER BY failed_at DESC`)
    .all() as DeadLetterEntry[];
}

// --- Outbound dedup (RISK-013 Chunk 3) ---
//
// Rolling 15-min bucket + 8-bucket (120min) lookback. 120min safely exceeds
// the current QUEUE_HARD_TIMEOUT (90min) with margin and continues to cover
// the post-1b 60min number, so this window does NOT need re-tuning when 1b
// lands. Wider than v2.1's 30min because Jul9→10 recurrences were
// ~22min-spaced repeats over ~90min — at/past the edge of a 30min window.
//
// Tradeoff (accepted): a legitimate short repeat of the exact same text
// within 2h is uncommon in practice and, if it occurs, visible to Lucas (no
// response arrives, he can repeat). Contrast with the failure mode this
// window closes — an invisible silent re-run burning tokens with zero
// output — which is strictly worse.
const BUCKET_MS = 15 * 60 * 1000;
const LOOKBACK_BUCKETS = 8; // 8 * 15min = 120min

// 24h TTL for table hygiene only (correctness window is LOOKBACK_BUCKETS
// above; this is unrelated and much longer). Cleanup runs opportunistically
// on every insert to avoid a separate scheduled worker — outbound sends
// aren't high-frequency enough for an indexed DELETE per insert to matter.
const OUTBOUND_HASH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize outbound text before hashing. Deliberately explicit:
 *   - trim leading/trailing whitespace
 *   - collapse internal whitespace runs to a single space
 * Deliberately NOT included: no lowercasing (case is meaningful); no
 * punctuation stripping (trailing "." vs "" is meaningful). Written down
 * here so implementation doesn't silently drift.
 */
export function normalizeOutbound(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function hashOutbound(
  groupJid: string,
  normalized: string,
  bucket: number,
): string {
  return createHash('sha256')
    .update(`${groupJid}:${bucket}:${normalized}`)
    .digest('hex');
}

function outboundDedupCandidateHashes(
  groupJid: string,
  normalized: string,
  sentAt: number,
): string[] {
  const currentBucket = Math.floor(sentAt / BUCKET_MS);
  const hashes: string[] = [];
  for (let k = 0; k < LOOKBACK_BUCKETS; k++) {
    hashes.push(hashOutbound(groupJid, normalized, currentBucket - k));
  }
  return hashes;
}

/**
 * Returns the MOST RECENT prior send's `sent_at` (ms epoch) if `normalized`
 * is a duplicate within the LOOKBACK_BUCKETS window, or `null` if it is not.
 * Callers use `=== null` as the "not a duplicate" test.
 *
 * MAX (not MIN): callers use the return value to compute how long since the
 * PREVIOUS occurrence, so they can gate an ops alert on "5+ min since the
 * most recent copy" (long-backoff retry storms won't false-alert on their
 * tail). See v2.4 review + Lucas's MIN→MAX decision.
 *
 * v2.4 fix 1: wrapped in try/catch and FAILS OPEN. A DB error here (locked
 * file, disk issue, etc.) must never abort what could be a real,
 * safety-critical send further up the call chain — the caller treats a
 * null return as "not a duplicate" and proceeds to channel.sendMessage
 * exactly as it would on a genuine cache miss. Worst case of a DB hiccup:
 * one send loses dedup coverage. Strictly preferable to a real send being
 * silently aborted.
 */
export function checkOutboundDedup(
  groupJid: string,
  normalized: string,
  sentAt: number,
): number | null {
  try {
    const candidates = outboundDedupCandidateHashes(
      groupJid,
      normalized,
      sentAt,
    );
    const placeholders = candidates.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT MAX(sent_at) AS sent_at FROM outbound_hashes WHERE hash IN (${placeholders})`,
      )
      .get(...candidates) as { sent_at: number | null } | undefined;
    return row?.sent_at ?? null;
  } catch (err) {
    logger.warn(
      { err, groupJid },
      'checkOutboundDedup: lookup failed, failing open (treating as not-duplicate so the send proceeds)',
    );
    return null;
  }
}

/**
 * Record the hash of a genuinely-delivered outbound send. Call ONLY after
 * confirmed delivery (outputSentToUser = true, saveState() persisted).
 * v2.4 fix 2 constraint: never called before the delivery is settled — a
 * throw here must not roll back an already-persisted send. The caller
 * wraps this in a try/catch that swallows write errors and logs WARN;
 * worst case is one send loses dedup coverage for future retries.
 *
 * Opportunistic TTL cleanup piggybacks on the insert — no separate worker.
 * Cheap because outbound sends aren't frequent enough for the indexed
 * DELETE to matter.
 */
export function recordOutboundSendHash(
  groupJid: string,
  normalized: string,
  sentAt: number,
): void {
  const currentBucket = Math.floor(sentAt / BUCKET_MS);
  db.prepare(
    `INSERT OR IGNORE INTO outbound_hashes (hash, sent_at) VALUES (?, ?)`,
  ).run(hashOutbound(groupJid, normalized, currentBucket), sentAt);
  db.prepare(`DELETE FROM outbound_hashes WHERE sent_at < ?`).run(
    sentAt - OUTBOUND_HASH_TTL_MS,
  );
}

// --- Inbound dedup (RISK-013 Chunk 5b) ---
//
// Records the hash of every fully-processed inbound batch (at
// outputSentToUser = true inside processGroupMessages). A retry that lands the
// same batch again — the Jul-8 00:48 pattern where a hang-timeout requeue
// re-delivers content the earlier run already answered — hits the check gate
// BEFORE runAgent is invoked and skips the entire container spawn.
//
// Same 15-min bucket / 120-min lookback as Chunk 3's outbound-dedup —
// deliberate reuse: same failure surface, no confirmed evidence inbound
// retries span a different timescale. Fails OPEN on DB error.
const INBOUND_BUCKET_MS = 15 * 60 * 1000;
const INBOUND_LOOKBACK_BUCKETS = 8; // 8 * 15min = 120min
const INBOUND_HASH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize inbound text before hashing. Identical to normalizeOutbound —
 * see there for the deliberate NOT-lowercased / NOT-punctuation-stripped
 * design decision.
 */
export function normalizeInbound(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function inboundHash(
  primaryJid: string,
  normalized: string,
  bucket: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify([primaryJid, bucket, normalized]))
    .digest('hex');
}

function inboundDedupCandidateHashes(
  primaryJid: string,
  normalized: string,
  processedAt: number,
): string[] {
  const currentBucket = Math.floor(processedAt / INBOUND_BUCKET_MS);
  const hashes: string[] = [];
  for (let k = 0; k < INBOUND_LOOKBACK_BUCKETS; k++) {
    hashes.push(inboundHash(primaryJid, normalized, currentBucket - k));
  }
  return hashes;
}

/**
 * Returns MIN(processed_at) (ms epoch) if `normalized` is a duplicate within
 * the lookback window, or null otherwise. Fails OPEN on any DB error — a
 * lookup fault must never block a real inbound send from proceeding.
 */
export function checkInboundDedup(
  primaryJid: string,
  normalized: string,
  processedAt: number,
): number | null {
  try {
    const candidates = inboundDedupCandidateHashes(
      primaryJid,
      normalized,
      processedAt,
    );
    const placeholders = candidates.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT MIN(processed_at) AS processed_at FROM inbound_processed_hashes WHERE hash IN (${placeholders})`,
      )
      .get(...candidates) as { processed_at: number | null } | undefined;
    return row?.processed_at ?? null;
  } catch (err) {
    logger.warn(
      { err, primaryJid },
      'checkInboundDedup: lookup failed, failing open',
    );
    return null;
  }
}

/**
 * Records that this exact batch has been fully processed. Call ONLY after
 * outputSentToUser = true. Errors are logged and swallowed — a hash write
 * fault must never roll back a delivery that already happened.
 */
export function recordInboundProcessedHash(
  primaryJid: string,
  normalized: string,
  processedAt: number,
): void {
  try {
    const currentBucket = Math.floor(processedAt / INBOUND_BUCKET_MS);
    db.prepare(
      `INSERT OR IGNORE INTO inbound_processed_hashes (hash, chat_jid, processed_at) VALUES (?, ?, ?)`,
    ).run(
      inboundHash(primaryJid, normalized, currentBucket),
      primaryJid,
      processedAt,
    );
    db.prepare(
      `DELETE FROM inbound_processed_hashes WHERE processed_at < ?`,
    ).run(processedAt - INBOUND_HASH_TTL_MS);
  } catch (err) {
    logger.warn(
      { err, primaryJid },
      'recordInboundProcessedHash failed; run already completed and is not rolled back',
    );
  }
}

// --- JID Linking (channel unification) ---

export function linkJid(secondaryJid: string, primaryJid: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO jid_links (secondary_jid, primary_jid) VALUES (?, ?)',
  ).run(secondaryJid, primaryJid);
}

export function unlinkJid(secondaryJid: string): void {
  db.prepare('DELETE FROM jid_links WHERE secondary_jid = ?').run(secondaryJid);
}

export function getAllJidLinks(): Array<{
  secondary_jid: string;
  primary_jid: string;
}> {
  return db
    .prepare('SELECT secondary_jid, primary_jid FROM jid_links')
    .all() as Array<{ secondary_jid: string; primary_jid: string }>;
}

export function getLinkedJids(primaryJid: string): string[] {
  const rows = db
    .prepare('SELECT secondary_jid FROM jid_links WHERE primary_jid = ?')
    .all(primaryJid) as Array<{ secondary_jid: string }>;
  return rows.map((r) => r.secondary_jid);
}
