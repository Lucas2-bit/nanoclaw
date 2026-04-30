import { randomUUID } from 'crypto';

import {
  getPendingDeadLetters,
  insertDeadLetter,
  resolveDeadLetter,
  updateDeadLetterRetry,
} from './db.js';
import { logger } from './logger.js';

/** How often to attempt retrying pending dead letter entries (ms). */
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Maximum number of send attempts before a message is permanently failed. */
const MAX_DLQ_RETRIES = 3;

/**
 * Record a failed outbound message in the dead letter queue instead of
 * silently dropping it.
 *
 * @param chatJid   The destination JID that the message was intended for.
 * @param content   The message text that failed to send.
 * @param groupFolder  The group folder (may be null for system messages).
 * @param error     The error that caused the send failure.
 */
export function recordSendFailure(
  chatJid: string,
  content: string,
  groupFolder: string | null,
  error: unknown,
): void {
  const lastError = error instanceof Error ? error.message : String(error);
  insertDeadLetter({
    id: randomUUID(),
    group_folder: groupFolder,
    chat_jid: chatJid,
    content,
    failed_at: new Date().toISOString(),
    last_error: lastError,
  });
  logger.warn(
    { chatJid, groupFolder, lastError },
    'dead-letter: outbound message recorded to dead letter queue',
  );
}

/**
 * Start the dead letter retry worker.
 * Every RETRY_INTERVAL_MS, the worker attempts to resend pending entries.
 * After MAX_DLQ_RETRIES failures the entry is permanently marked as failed.
 *
 * @param sendMessage  Async function that delivers a message to a JID.
 *   Should throw on failure so the worker can handle it.
 */
export function startDeadLetterWorker(
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  logger.info(
    {
      intervalMs: RETRY_INTERVAL_MS,
      maxRetries: MAX_DLQ_RETRIES,
    },
    'dead-letter: retry worker started',
  );

  const loop = async () => {
    try {
      const pending = getPendingDeadLetters(MAX_DLQ_RETRIES);
      if (pending.length > 0) {
        logger.info(
          { count: pending.length },
          'dead-letter: retrying pending entries',
        );
      }

      for (const entry of pending) {
        if (!entry.chat_jid || !entry.content) {
          // Malformed entry — mark as permanently failed
          resolveDeadLetter(entry.id, -1);
          logger.warn(
            { id: entry.id },
            'dead-letter: malformed entry permanently failed',
          );
          continue;
        }

        try {
          await sendMessage(entry.chat_jid, entry.content);
          resolveDeadLetter(entry.id, 1);
          logger.info(
            { id: entry.id, chatJid: entry.chat_jid },
            'dead-letter: entry resent successfully',
          );
        } catch (err) {
          const lastError = err instanceof Error ? err.message : String(err);
          const nextRetryCount = entry.retry_count + 1;

          if (nextRetryCount >= MAX_DLQ_RETRIES) {
            // Exhausted retries — mark as permanently failed
            updateDeadLetterRetry(entry.id, lastError);
            resolveDeadLetter(entry.id, -1);
            logger.error(
              { id: entry.id, chatJid: entry.chat_jid, lastError },
              'dead-letter: entry permanently failed after max retries',
            );
          } else {
            updateDeadLetterRetry(entry.id, lastError);
            logger.warn(
              {
                id: entry.id,
                chatJid: entry.chat_jid,
                retryCount: nextRetryCount,
                lastError,
              },
              'dead-letter: retry failed, will try again',
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'dead-letter: error in retry loop');
    }

    setTimeout(loop, RETRY_INTERVAL_MS);
  };

  // First retry pass is deferred so the system can finish startup
  setTimeout(loop, RETRY_INTERVAL_MS);
}
