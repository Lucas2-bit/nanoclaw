// Integration-style tests: confirm each channel's sendMessage path
// actually routes through guardedOutbound by mocking the underlying
// transport and asserting suppression of held messages.

import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// vi.mock factories hoist above top-level vars. Build the tmp dir inside
// the factory and expose its path via process.env for the test body.
vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const dir = fsMod.mkdtempSync(
    pathMod.join(osMod.tmpdir(), 'nanoclaw-guard-integ-'),
  );
  process.env.NANOCLAW_GUARD_INTEG_TMP = dir;
  return {
    DATA_DIR: dir,
    STORE_DIR: pathMod.join(dir, 'store'),
    GROUPS_DIR: pathMod.join(dir, 'groups'),
    ASSISTANT_NAME: 'Andy',
    ASSISTANT_HAS_OWN_NUMBER: false,
    TRIGGER_PATTERN: /^@Andy\b/i,
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../image.js', () => ({
  isImageMessage: vi.fn(() => false),
  processImage: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// transcription.ts imports util.promisify(execFile); short-circuit it so
// the channel under test never tries to invoke a whisper binary.
vi.mock('../transcription.js', () => ({
  isVoiceMessage: vi.fn(() => false),
  transcribeAudioMessage: vi.fn(async () => null),
  transcribeWithWhisperCpp: vi.fn(async () => null),
}));

vi.mock('../voice-transcription.js', () => ({
  transcribeWithGroq: vi.fn(async () => null),
}));

let fakeSocket: ReturnType<typeof createFakeSocket>;

function createFakeSocket() {
  const ev = new EventEmitter();
  return {
    ev: {
      on: (e: string, h: (...args: unknown[]) => void) => ev.on(e, h),
    },
    user: { id: '1@s.whatsapp.net', lid: '2@lid' },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    _ev: ev,
  };
}

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(() => fakeSocket),
  Browsers: { macOS: vi.fn(() => ['macOS', 'Chrome', '']) },
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: vi.fn(),
  fetchLatestWaWebVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  normalizeMessageContent: vi.fn((x: unknown) => x),
  makeCacheableSignalKeyStore: vi.fn((k: unknown) => k),
  useMultiFileAuthState: vi
    .fn()
    .mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
}));

import { WhatsAppChannel } from '../channels/whatsapp.js';

async function connectWa(channel: WhatsAppChannel): Promise<void> {
  const connectPromise = channel.connect();
  await new Promise((r) => setTimeout(r, 0));
  fakeSocket._ev.emit('connection.update', { connection: 'open' });
  await connectPromise;
}

const ALERTS_DIR = path.join(
  process.env.NANOCLAW_GUARD_INTEG_TMP || '',
  'alerts',
);

function clearAlerts(): void {
  if (!fs.existsSync(ALERTS_DIR)) return;
  for (const f of fs.readdirSync(ALERTS_DIR)) {
    const full = path.join(ALERTS_DIR, f);
    if (fs.statSync(full).isFile()) fs.unlinkSync(full);
  }
}

function countAlerts(): number {
  if (!fs.existsSync(ALERTS_DIR)) return 0;
  return fs
    .readdirSync(ALERTS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile()).length;
}

describe('WhatsAppChannel.sendMessage guard integration', () => {
  beforeEach(() => {
    fakeSocket = createFakeSocket();
    clearAlerts();
  });

  it('delivers a benign message', async () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await connectWa(channel);

    await channel.sendMessage('test@g.us', 'meeting at 3pm');

    expect(fakeSocket.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
      text: 'Andy: meeting at 3pm',
    });
    expect(countAlerts()).toBe(0);
  });

  it('delivers a held allergen message AND writes an alert (alert-and-pass)', async () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await connectWa(channel);

    await channel.sendMessage('test@g.us', 'Augmentin is fine for Oliver');

    // Original message MUST still be delivered (no suppression).
    expect(fakeSocket.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
      text: 'Andy: Augmentin is fine for Oliver',
    });
    // Alert file still written for the human audit trail.
    expect(countAlerts()).toBe(1);
  });

  it('drain path also alerts-and-passes — held queued messages still flush', async () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    // Queue both before connecting
    await channel.sendMessage('test@g.us', 'meeting at 3pm');
    await channel.sendMessage('test@g.us', 'Augmentin is fine for Oliver');

    await connectWa(channel);

    // Give the async flush a moment
    await new Promise((r) => setTimeout(r, 20));

    // Both should be delivered; the held one also produces an alert.
    expect(fakeSocket.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
      text: 'Andy: meeting at 3pm',
    });
    expect(fakeSocket.sendMessage).toHaveBeenCalledWith('test@g.us', {
      text: 'Andy: Augmentin is fine for Oliver',
    });
    expect(countAlerts()).toBe(1);
  });
});

// --- Telegram ---

vi.mock('grammy', () => {
  const sentMessages: Array<{
    chatId: string | number;
    text: string;
    parse_mode?: string;
  }> = [];
  class FakeBot {
    api = {
      sendMessage: vi.fn(
        async (
          chatId: string | number,
          text: string,
          opts?: { parse_mode?: string },
        ) => {
          sentMessages.push({ chatId, text, parse_mode: opts?.parse_mode });
        },
      ),
      sendVoice: vi.fn(),
      sendChatAction: vi.fn(),
      getFile: vi.fn(),
    };
    constructor(public token: string) {}
    command = vi.fn();
    on = vi.fn();
    catch = vi.fn();
    start(opts: {
      onStart: (botInfo: { username: string; id: number }) => void;
    }) {
      setTimeout(() => opts.onStart({ username: 'andy_ai_bot', id: 99 }), 0);
    }
    stop = vi.fn();
  }
  return { Bot: FakeBot, InputFile: class {}, _sent: sentMessages };
});

import { TelegramChannel } from '../channels/telegram.js';
import * as grammyMod from 'grammy';

describe('TelegramChannel.sendMessage guard integration', () => {
  beforeEach(() => {
    clearAlerts();
    // Reset captured sent messages between tests
    (grammyMod as unknown as { _sent: unknown[] })._sent.length = 0;
  });

  it('delivers a benign message', async () => {
    const channel = new TelegramChannel('tkn', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await channel.connect();

    await channel.sendMessage('tg:42', 'meeting at 3pm');

    const sent = (grammyMod as unknown as { _sent: Array<{ text: string }> })
      ._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('meeting at 3pm');
    expect(countAlerts()).toBe(0);
  });

  it('delivers a held message AND writes an alert (alert-and-pass)', async () => {
    const channel = new TelegramChannel('tkn', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await channel.connect();

    await channel.sendMessage('tg:42', 'Augmentin is fine for Oliver');

    const sent = (grammyMod as unknown as { _sent: Array<{ text: string }> })
      ._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('Augmentin is fine for Oliver');
    expect(countAlerts()).toBe(1);
  });
});
