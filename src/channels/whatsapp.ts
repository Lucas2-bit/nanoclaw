import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { isImageMessage, processImage } from '../image.js';
import { logger } from '../logger.js';
import { guardedOutbound } from '../safety/outbound-guard.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// FIX 2 (MF2): when WhatsApp is logged out or needs QR re-auth, we write this
// lock instead of exiting. A restart/respin cannot re-authenticate WhatsApp, so
// the startup path refuses to spin a doomed client while the lock is present
// (it pages via the supervisor signal and waits). The lock is cleared on a
// successful connection. Out-of-band `/setup` (a separate process) performs the
// actual QR scan and clears the lock by connecting successfully.
const WHATSAPP_REAUTH_LOCK = path.join(DATA_DIR, 'whatsapp-reauth.lock');

function writeReauthLock(reason: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      WHATSAPP_REAUTH_LOCK,
      JSON.stringify({ ts: Date.now(), reason }),
    );
  } catch {
    /* non-fatal */
  }
}

function clearReauthLock(): void {
  try {
    if (fs.existsSync(WHATSAPP_REAUTH_LOCK))
      fs.unlinkSync(WHATSAPP_REAUTH_LOCK);
  } catch {
    /* non-fatal */
  }
}

function reauthLockPresent(): boolean {
  try {
    return fs.existsSync(WHATSAPP_REAUTH_LOCK);
  } catch {
    return false;
  }
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    // FIX 2 (MF2): if a re-auth lock is present, WhatsApp is logged out / needs
    // a human QR scan. Spinning a client here would just hit the same logout and
    // loop (pm2 would also respin us if we exited). Stay up, do NOT spin a doomed
    // client; re-check periodically. The lock is cleared once `/setup` writes
    // valid creds and a subsequent connection succeeds.
    if (reauthLockPresent()) {
      logger.warn(
        'WhatsApp re-auth lock present — not starting client (needs human /setup). Will re-check in 60s.',
      );
      setTimeout(() => {
        this.connectInternal(onFirstOpen).catch((err) => {
          logger.error({ err }, 'WhatsApp re-auth re-check failed');
        });
      }, 60_000).unref?.();
      return;
    }
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        // FIX 2 (MF2): QR re-auth is human-only. Write a re-auth lock and signal
        // the supervisor to PAGE Lucas, but do NOT exit — exiting would let pm2
        // autorestart us straight back into the same QR, an unbounded loop. We
        // stay up and stop this doomed socket; the lock gates any reconnect.
        writeReauthLock('whatsapp-qr-required');
        const _sigPath = path.join(DATA_DIR, 'supervisor-signal.json');
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(
            _sigPath + '.tmp',
            JSON.stringify({
              ts: Date.now(),
              reason: 'whatsapp-qr-required',
              pid: process.pid,
            }),
          );
          fs.renameSync(_sigPath + '.tmp', _sigPath);
        } catch (_e) {
          /* non-fatal */
        }
        try {
          this.sock?.end(undefined);
        } catch (_e) {
          /* non-fatal */
        }
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          this.scheduleReconnect(1);
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          // FIX 2 (MF2): logout is human-only. Write a re-auth lock and signal the
          // supervisor to PAGE Lucas, but do NOT exit and do NOT reconnect —
          // exiting would let pm2 autorestart us into the same logout (a loop),
          // and reconnecting cannot re-authenticate. Stay up; the lock gates any
          // future client spin until /setup restores valid creds.
          writeReauthLock('whatsapp-logged-out');
          const _sigPath2 = path.join(DATA_DIR, 'supervisor-signal.json');
          try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(
              _sigPath2 + '.tmp',
              JSON.stringify({
                ts: Date.now(),
                reason: 'whatsapp-logged-out',
                pid: process.pid,
              }),
            );
            fs.renameSync(_sigPath2 + '.tmp', _sigPath2);
          } catch (_e) {
            /* non-fatal */
          }
        }
      } else if (connection === 'open') {
        this.connected = true;
        // FIX 2 (MF2): a successful connection means auth is valid again — clear
        // any re-auth lock so normal operation resumes.
        clearReauthLock();
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          isGroup,
        );

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          const normalized = normalizeMessageContent(msg.message);

          let content =
            normalized?.conversation ||
            normalized?.extendedTextMessage?.text ||
            normalized?.imageMessage?.caption ||
            normalized?.videoMessage?.caption ||
            '';

          // Image attachment handling
          if (isImageMessage(msg)) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
              const caption = normalized?.imageMessage?.caption ?? '';
              const result = await processImage(
                buffer as Buffer,
                groupDir,
                caption,
              );
              if (result) {
                content = result.content;
              }
            } catch (err) {
              logger.warn({ err, jid: chatJid }, 'Image - download failed');
            }
          }

          // PDF attachment handling
          if (normalized?.documentMessage?.mimetype === 'application/pdf') {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
              const attachDir = path.join(groupDir, 'attachments');
              fs.mkdirSync(attachDir, { recursive: true });
              const filename = path.basename(
                normalized.documentMessage.fileName || `doc-${Date.now()}.pdf`,
              );
              const filePath = path.join(attachDir, filename);
              fs.writeFileSync(filePath, buffer as Buffer);
              const sizeKB = Math.round((buffer as Buffer).length / 1024);
              const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
              const caption = normalized.documentMessage.caption || '';
              content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
              logger.info(
                { jid: chatJid, filename },
                'Downloaded PDF attachment',
              );
            } catch (err) {
              logger.warn(
                { err, jid: chatJid },
                'Failed to download PDF attachment',
              );
            }
          }

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          // but allow voice messages through for transcription
          if (!content && !isVoiceMessage(msg)) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          // Transcribe voice messages before storing
          let finalContent = content;
          if (isVoiceMessage(msg)) {
            try {
              const transcript = await transcribeAudioMessage(msg, this.sock);
              if (transcript) {
                finalContent = `[Voice: ${transcript}]`;
                logger.info(
                  { chatJid, length: transcript.length },
                  'Transcribed voice message',
                );
              } else {
                finalContent = '[Voice Message - transcription unavailable]';
              }
            } catch (err) {
              logger.error({ err }, 'Voice transcription error');
              finalContent = '[Voice Message - transcription failed]';
            }
          }

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: finalContent,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
  }

  /** Track recently sent messages to prevent duplicates (key: jid+hash, expires after 60s) */
  private recentlySent = new Map<string, number>();

  private dedupeKey(jid: string, text: string): string {
    // Simple hash: first 100 chars + length to avoid collisions without crypto overhead
    return `${jid}:${text.length}:${text.slice(0, 100)}`;
  }

  private isDuplicate(jid: string, text: string): boolean {
    const key = this.dedupeKey(jid, text);
    const lastSent = this.recentlySent.get(key);
    if (lastSent && Date.now() - lastSent < 60_000) {
      logger.warn({ jid, length: text.length }, 'Duplicate message suppressed');
      return true;
    }
    return false;
  }

  private markSent(jid: string, text: string): void {
    const key = this.dedupeKey(jid, text);
    this.recentlySent.set(key, Date.now());
    // Clean up old entries every 100 sends
    if (this.recentlySent.size > 200) {
      const now = Date.now();
      for (const [k, ts] of this.recentlySent) {
        if (now - ts > 60_000) this.recentlySent.delete(k);
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<boolean> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    // Deduplicate: skip if same message was sent to same JID in last 60s.
    // The user did NOT receive a fresh send here — return false so callers
    // don't double-advance cursors or fire follow-ups (e.g. voice note).
    if (this.isDuplicate(jid, prefixed)) return false;

    if (!this.connected) {
      // Check queue for existing identical message before adding
      const alreadyQueued = this.outgoingQueue.some(
        (item) => item.jid === jid && item.text === prefixed,
      );
      if (alreadyQueued) {
        logger.info({ jid }, 'Message already in queue, skipping duplicate');
        return false;
      }
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return false;
    }
    try {
      return await guardedOutbound(
        jid,
        prefixed,
        async () => {
          await this.sock.sendMessage(jid, { text: prefixed });
          this.markSent(jid, prefixed);
          logger.info({ jid, length: prefixed.length }, 'Message sent');
        },
        { channel: 'whatsapp', medium: 'text' },
      );
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  /**
   * Liveness check for the WhatsApp channel.
   * Returns true when the socket is connected.  If it is not connected,
   * logs a warning and returns false so the caller can escalate after
   * repeated failures.
   *
   * Note: reconnection is already handled automatically by the Baileys
   * connection.update handler (scheduleReconnect).  This method only
   * surfaces the current state for external health monitoring.
   */
  async healthCheck(): Promise<boolean> {
    if (this.connected) return true;

    logger.warn('WhatsApp health check: channel is not connected');
    return false;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private scheduleReconnect(attempt: number): void {
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
    logger.info({ attempt, delayMs }, 'Reconnecting...');
    setTimeout(() => {
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt }, 'Reconnection attempt failed');
        this.scheduleReconnect(attempt + 1);
      });
    }, delayMs);
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      // Deduplicate queue before flushing
      const seen = new Set<string>();
      const deduped: typeof this.outgoingQueue = [];
      for (const item of this.outgoingQueue) {
        const key = this.dedupeKey(item.jid, item.text);
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(item);
        } else {
          logger.info(
            { jid: item.jid },
            'Removed duplicate from outgoing queue',
          );
        }
      }
      this.outgoingQueue = deduped;

      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Skip if already sent recently (e.g. by another code path)
        if (this.isDuplicate(item.jid, item.text)) continue;
        // Send directly — queued items are already prefixed by sendMessage.
        // Bypasses sendMessage(), so we re-apply the outbound safety guard here.
        // Drop on HOLD: the guard already wrote an alert and logged
        // SAFETY-CRITICAL; re-queueing would replay it forever.
        const delivered = await guardedOutbound(
          item.jid,
          item.text,
          async () => {
            await this.sock.sendMessage(item.jid, { text: item.text });
            this.markSent(item.jid, item.text);
            logger.info(
              { jid: item.jid, length: item.text.length },
              'Queued message sent',
            );
          },
          { channel: 'whatsapp', medium: 'text-drain' },
        );
        if (!delivered) {
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued message HELD by guard — dropped (not requeued)',
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  const authDir = path.join(STORE_DIR, 'auth');
  if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
    logger.warn(
      'WhatsApp: credentials not found. Run /add-whatsapp to authenticate.',
    );
    return null;
  }
  return new WhatsAppChannel(opts);
});
