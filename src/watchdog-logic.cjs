// watchdog-logic.cjs
// Pure decision functions extracted from watchdog-v2.cjs so they can be unit
// tested against the REAL shipping code path (review SHOULD-FIX D). watchdog-v2
// requires these; the vitest suite imports the same functions. No I/O here.

'use strict';

/**
 * D2: Classify the current queue state.
 *   idle     -- activeCount === 0. Normal rest state.
 *   busy     -- activeCount > 0 AND tick fresh. Legitimately working.
 *   hung     -- activeCount > 0 AND tick stale. Event loop stalled.
 *   no-state -- queue-state.json absent/unreadable.
 * Clock-step tolerant: negative age (NTP step forward) treated as stale.
 */
function classifyQueueState(qs, tickStaleThresholdMs, now = Date.now()) {
  if (!qs) return 'no-state';
  const age = now - qs.tick_ts;
  const tickStale = age < 0 || age > tickStaleThresholdMs;
  if (qs.activeCount === 0) return 'idle';
  if (!tickStale) return 'busy';
  return 'hung';
}

/**
 * MF4: Is a supervisor restart permitted by the cooldown/ceiling policy?
 * Pure over the passed state object { ceilingHit, history: [{ts}] }.
 */
function checkRestartAllowed(state, cooldownN, windowMs, now = Date.now()) {
  if (state.ceilingHit) {
    return { allowed: false, reason: 'ceiling-hit' };
  }
  const windowStart = now - windowMs;
  const recent = state.history.filter((r) => r.ts > windowStart);
  if (recent.length >= cooldownN) {
    return { allowed: false, reason: 'cooldown-exceeded' };
  }
  return { allowed: true };
}

/**
 * D1: Zero-successful-runs alarm (the 05-31 detector).
 * Fires when nanoclaw is healthy, old enough to have completed work, has had
 * NO genuine end-to-end completion in the window, AND there was outstanding
 * work at some point inside the window.
 *
 * MF4 fix: active-work is evaluated over the WINDOW via lastActiveAt, NOT the
 * instantaneous activeCount, so a retry-backoff gap cannot hide a dead system.
 *
 * @returns { fire: boolean, reason?: string }
 */
function evaluateD1Alarm(params) {
  const {
    pm2Healthy,
    qs,
    windowMs,
    pm2UptimeMs,
    now = Date.now(),
  } = params;
  if (!pm2Healthy || !qs) return { fire: false, reason: 'no-state-or-unhealthy' };
  const windowStart = now - windowMs;
  const noRecentSuccess =
    qs.lastSuccessAt === null ||
    qs.lastSuccessAt === undefined ||
    qs.lastSuccessAt < windowStart;
  // Process must be up long enough to realistically have completed work.
  const processOldEnough = pm2UptimeMs > windowMs;
  // Windowed active-work: there was outstanding work (active container OR a
  // scheduled retry) at some instant within the window. Falls back to the
  // instantaneous activeCount when lastActiveAt is absent (older state files).
  const hadActiveWorkInWindow =
    qs.activeCount > 0 ||
    (qs.lastActiveAt !== null &&
      qs.lastActiveAt !== undefined &&
      qs.lastActiveAt >= windowStart);
  if (noRecentSuccess && processOldEnough && hadActiveWorkInWindow) {
    return { fire: true, reason: 'zero-success-with-active-work' };
  }
  return { fire: false, reason: 'healthy-or-idle' };
}

// FIX 2 (MF2): supervisor signal reasons that need a HUMAN (WhatsApp re-auth).
// These must PAGE and must NOT trigger a supervised restart (a restart cannot
// re-authenticate WhatsApp and would loop).
const PAGE_ONLY_SIGNAL_REASONS = new Set([
  'whatsapp-logged-out',
  'whatsapp-qr-required',
]);

function isPageOnlyReason(reason) {
  return PAGE_ONLY_SIGNAL_REASONS.has(reason);
}

module.exports = {
  classifyQueueState,
  checkRestartAllowed,
  evaluateD1Alarm,
  isPageOnlyReason,
  PAGE_ONLY_SIGNAL_REASONS,
};
