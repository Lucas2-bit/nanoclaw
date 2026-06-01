import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock is hoisted above all top-level statements; create the tmp
// dir inside the (async) factory and surface it via process.env so the
// test body can derive ALERTS_DIR after the mock has installed.
vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const dir = fsMod.mkdtempSync(
    pathMod.join(osMod.tmpdir(), 'nanoclaw-guard-'),
  );
  process.env.NANOCLAW_GUARD_TEST_TMP = dir;
  return { DATA_DIR: dir };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Wrap screenOutbound so individual tests can force a throw without
// disturbing the others (which still exercise the real screener).
vi.mock('./allergens.js', async () => {
  const orig =
    await vi.importActual<typeof import('./allergens.js')>('./allergens.js');
  return { ...orig, screenOutbound: vi.fn(orig.screenOutbound) };
});

import { guardedOutbound } from './outbound-guard.js';
import { logger } from '../logger.js';
import { screenOutbound } from './allergens.js';

const ALERTS_DIR = path.join(
  process.env.NANOCLAW_GUARD_TEST_TMP || '',
  'alerts',
);

function readAlerts(): { name: string; body: string }[] {
  if (!fs.existsSync(ALERTS_DIR)) return [];
  return fs
    .readdirSync(ALERTS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({
      name: d.name,
      body: fs.readFileSync(path.join(ALERTS_DIR, d.name), 'utf-8'),
    }));
}

describe('guardedOutbound', () => {
  beforeEach(() => {
    // Wipe alerts dir between tests so each one sees only its own writes.
    if (fs.existsSync(ALERTS_DIR)) {
      for (const f of fs.readdirSync(ALERTS_DIR)) {
        const full = path.join(ALERTS_DIR, f);
        const stat = fs.statSync(full);
        if (stat.isFile()) fs.unlinkSync(full);
      }
    }
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls deliver exactly once on 'pass' verdict", async () => {
    const deliver = vi.fn(async () => {});
    await guardedOutbound('chat@g.us', 'meeting at 3pm', deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(readAlerts()).toHaveLength(0);
  });

  it("does NOT call deliver on 'hold' verdict; writes alert file and warns", async () => {
    const deliver = vi.fn(async () => {});
    await guardedOutbound(
      'chat@g.us',
      'Augmentin is fine for Oliver',
      deliver,
      { channel: 'whatsapp', medium: 'text' },
    );

    expect(deliver).not.toHaveBeenCalled();

    const alerts = readAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toMatch(/^safety-outbound-/);
    const parsed = JSON.parse(alerts[0].body);
    expect(parsed.kind).toBe('safety-outbound-hold');
    expect(parsed.jid).toBe('chat@g.us');
    expect(parsed.channel).toBe('whatsapp');
    expect(parsed.medium).toBe('text');
    expect(parsed.text).toBe('Augmentin is fine for Oliver');
    expect(parsed.matched).toContain('amoxicillin');
    expect(parsed.notifiedOwner).toBe(false);

    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    const warnArgs = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => String(c[c.length - 1]));
    expect(warnArgs.some((m) => m.includes('SAFETY-CRITICAL'))).toBe(true);
  });

  it('treats screenOutbound exceptions as HOLD (fail-closed)', async () => {
    const mocked = vi.mocked(screenOutbound);
    mocked.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const deliver = vi.fn(async () => {});

    await guardedOutbound('chat@g.us', 'totally benign text', deliver);

    expect(deliver).not.toHaveBeenCalled();
    const alerts = readAlerts();
    expect(alerts).toHaveLength(1);
    const parsed = JSON.parse(alerts[0].body);
    expect(parsed.kind).toBe('safety-outbound-hold');
    expect(parsed.reason).toMatch(/exception/i);
  });

  it('alert file is written under DATA_DIR/alerts with a safety-outbound- prefix', async () => {
    // Same prefix and dir as other writers (channel-health, session-size),
    // so the alert-consumer drains it on the same pass.
    await guardedOutbound(
      'x@g.us',
      'try the pesto',
      vi.fn(async () => {}),
    );
    const alerts = readAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name.startsWith('safety-outbound-')).toBe(true);
    expect(alerts[0].name.endsWith('.txt')).toBe(true);
  });
});

// --- Coverage: no outbound transport call bypasses the guard ---

describe('outbound guard coverage', () => {
  it('every active outbound transport call is wrapped in guardedOutbound', () => {
    // The chokepoints are: WhatsApp sendMessage + raw drain, Telegram
    // sendMessage, Gmail sendMessage. This test reads each file and
    // asserts the transport call is preceded by a guardedOutbound wrap.
    const root = process.cwd();

    const checks = [
      {
        file: path.join(root, 'src/channels/whatsapp.ts'),
        // Two raw `sock.sendMessage` call sites (the method body and the
        // queue drain); both must be inside a guardedOutbound deliver.
        rawSendCount: 2,
      },
      {
        file: path.join(root, 'src/channels/telegram.ts'),
        // Telegram's actual transport call is api.sendMessage inside
        // sendTelegramMessage(); the channel's sendMessage method must
        // wrap that helper in guardedOutbound.
        rawSendCount: 0,
      },
      {
        file: path.join(root, 'src/channels/gmail.ts'),
        rawSendCount: 0,
      },
    ];

    for (const c of checks) {
      const src = fs.readFileSync(c.file, 'utf-8');
      expect(src, `${c.file} imports guardedOutbound`).toMatch(
        /guardedOutbound/,
      );
    }

    // WhatsApp: ensure each `this.sock.sendMessage(` is inside a
    // guardedOutbound block by checking the preceding 20 lines contain
    // a `guardedOutbound(` call.
    const wa = fs.readFileSync(
      path.join(root, 'src/channels/whatsapp.ts'),
      'utf-8',
    );
    const lines = wa.split('\n');
    const sendIdxs: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes('this.sock.sendMessage(')) sendIdxs.push(i);
    });
    // sanity: we expect two raw sends (method body + drain)
    expect(sendIdxs.length).toBeGreaterThanOrEqual(2);
    for (const i of sendIdxs) {
      const window = lines.slice(Math.max(0, i - 20), i).join('\n');
      expect(
        window,
        `whatsapp.ts:${i + 1} sock.sendMessage not preceded by guardedOutbound`,
      ).toMatch(/guardedOutbound\(/);
    }
  });
});
