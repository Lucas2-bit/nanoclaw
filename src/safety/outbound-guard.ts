// Narrow allergen backstop for ALL outbound text. ALERT-AND-PASS:
// the deliver thunk is ALWAYS invoked. When the screener returns 'hold'
// (or throws), an alert is written to DATA_DIR/alerts/, a warn line is
// logged, AND a separate visible flag is pushed to the owner (Lucas) via
// the registered owner-push helper — but the original message still goes
// out. Lucas is the primary check (see allergens.ts); this is human
// awareness, not a suppression gate.
//
// It MUST NOT recurse: the alert file write, the warn log, and the owner
// push use a short, allergen-free flag string so guardedOutbound's
// screener never holds the flag itself.

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { screenOutbound } from './allergens.js';

const ALERTS_DIR = path.join(DATA_DIR, 'alerts');

// Fixed allergen-free flag text. Must stay free of allergen tokens and
// affirmative-context tokens (see ALLERGEN_TERMS and AFFIRMATIVE_CONTEXT
// in ./allergens.ts) so the screener cannot HOLD the flag itself.
const OWNER_FLAG_TEXT =
  'ALLERGEN FLAG - the message above asserts something about a hard-exclude allergen or medication; verify against the canonical list before acting.';

export interface GuardContext {
  channel?: string;
  medium?: string;
}

type OwnerPushFn = (text: string) => Promise<void>;

let ownerPush: OwnerPushFn | null = null;

/**
 * Register the helper used to push a visible flag to the owner (Lucas)
 * when the screener returns 'hold'. Called once at startup from
 * src/index.ts. If never registered, hold paths still deliver the
 * original message and still write the alert file — the owner push is
 * just skipped (with a log line).
 */
export function setOwnerPush(fn: OwnerPushFn | null): void {
  ownerPush = fn;
}

function writeHoldAlert(
  jid: string,
  text: string,
  matched: string[],
  reason: string,
  notifiedOwner: boolean,
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
        notifiedOwner,
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(ALERTS_DIR, filename), body, 'utf-8');
  } catch (err) {
    logger.warn(
      { err, jid, channel: ctx?.channel },
      'outbound-guard: failed to write hold alert file',
    );
  }
}

/**
 * Run the allergen screener over `text` and ALWAYS invoke `deliver`.
 * When the screener returns 'hold' (or throws), also write a structured
 * alert into DATA_DIR/alerts/, emit a SAFETY warn log, AND push a
 * separate visible flag to the owner via the registered owner-push
 * helper — but the message still goes out. Returns `true` (delivered);
 * the boolean is kept for caller-compatibility. Never throws.
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
    logger.warn(
      { err, jid, channel: ctx?.channel },
      'outbound-guard: screenOutbound threw — alerting and passing through',
    );
    verdict = {
      action: 'hold',
      matched: [],
      reason: 'screenOutbound exception',
    };
  }

  if (verdict.action === 'hold') {
    logger.warn(
      {
        jid,
        channel: ctx?.channel,
        medium: ctx?.medium,
        matched: verdict.matched,
        reason: verdict.reason,
        textLength: text.length,
      },
      'SAFETY: outbound flagged by allergen backstop — alerting, not suppressing',
    );

    // Primary signal: push a visible flag to the owner. Failure must
    // never throw out of the guard — the file-alert below is the
    // backup signal and the original message has already been queued
    // for delivery below.
    let notifiedOwner = false;
    if (ownerPush) {
      try {
        await ownerPush(OWNER_FLAG_TEXT);
        notifiedOwner = true;
      } catch (err) {
        logger.warn(
          { err, jid, channel: ctx?.channel },
          'outbound-guard: owner push failed — message still delivered, alert file still written',
        );
      }
    } else {
      logger.warn(
        { jid, channel: ctx?.channel },
        'outbound-guard: no ownerPush registered — only file alert + log',
      );
    }

    writeHoldAlert(
      jid,
      text,
      verdict.matched,
      verdict.reason,
      notifiedOwner,
      ctx,
    );
  }

  await deliver();
  return true;
}
