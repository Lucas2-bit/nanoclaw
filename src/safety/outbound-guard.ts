// Narrow allergen backstop for ALL outbound text. Fail-closed: if the
// underlying screener throws OR the screener returns 'hold', the deliver
// thunk is NOT invoked — the send is suppressed, an alert is written to
// DATA_DIR/alerts/ (drained by alert-consumer), and a warn line is logged.
//
// This is a NARROW backstop, not the primary safety guarantee (see
// allergens.ts). It MUST NOT recurse: the alert file write and the warn
// log do not go back through any channel send. No owner ping is wired
// from this module — surfacing held messages to a human is intentionally
// left to the alert-consumer + log path.

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { screenOutbound } from './allergens.js';

const ALERTS_DIR = path.join(DATA_DIR, 'alerts');

export interface GuardContext {
  channel?: string;
  medium?: string;
}

function writeHoldAlert(
  jid: string,
  text: string,
  matched: string[],
  reason: string,
  ctx?: GuardContext,
): void {
  try {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
    const filename = `safety-outbound-${Date.now()}-${process.pid}.txt`;
    const body = JSON.stringify(
      {
        kind: 'safety-outbound-hold',
        jid,
        channel: ctx?.channel,
        medium: ctx?.medium,
        matched,
        reason,
        text,
        notifiedOwner: false,
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(ALERTS_DIR, filename), body, 'utf-8');
  } catch (err) {
    // The write itself failing must never throw out of the guard — the
    // send is still suppressed and the warn log below still fires.
    logger.warn(
      { err, jid, channel: ctx?.channel },
      'outbound-guard: failed to write hold alert file',
    );
  }
}

/**
 * Run the allergen screener over `text`. If it returns 'pass', invoke
 * `deliver` and resolve `true` (delivered). If it returns 'hold' (or the
 * screener throws), suppress the send: write a structured alert into
 * DATA_DIR/alerts/, emit a SAFETY-CRITICAL warn log, and resolve `false`
 * so the caller can tell the message did not reach the user. Never throws.
 *
 * Callers pass the actual transport call as the `deliver` thunk so the
 * guard sits in front of every send.
 */
export async function guardedOutbound(
  jid: string,
  text: string,
  deliver: () => Promise<void>,
  ctx?: GuardContext,
): Promise<boolean> {
  let verdict: ReturnType<typeof screenOutbound>;
  try {
    verdict = screenOutbound(text);
  } catch (err) {
    // Fail-closed: any unexpected screener failure is treated as HOLD.
    logger.warn(
      { err, jid, channel: ctx?.channel },
      'outbound-guard: screenOutbound threw — treating as HOLD',
    );
    verdict = {
      action: 'hold',
      matched: [],
      reason: 'screenOutbound exception — defaulting to HOLD',
    };
  }

  if (verdict.action === 'pass') {
    await deliver();
    return true;
  }

  writeHoldAlert(jid, text, verdict.matched, verdict.reason, ctx);
  logger.warn(
    {
      jid,
      channel: ctx?.channel,
      medium: ctx?.medium,
      matched: verdict.matched,
      reason: verdict.reason,
      textLength: text.length,
    },
    'SAFETY-CRITICAL: outbound HELD by allergen backstop — send suppressed',
  );
  return false;
}
