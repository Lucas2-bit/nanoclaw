import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

/**
 * Single source for dropping plain-text alert files for alert-consumer.ts to
 * drain. Filename pattern: ${prefix}-${Date.now()}.txt. The prefix is what
 * inferSource() in alert-consumer pivots on (e.g. "safety", "git-integrity",
 * "channel-health", "session-size"). Body is UTF-8 text — JSON is fine but
 * not required.
 *
 * NEVER THROWS. Callers must be able to drop an alert from any boot/runtime
 * path, including hot recovery code, without risking a crash.
 */
export function writeAlertFile(message: string, prefix = 'alert'): void {
  try {
    const alertDir = path.join(DATA_DIR, 'alerts');
    fs.mkdirSync(alertDir, { recursive: true });
    const filename = `${prefix}-${Date.now()}.txt`;
    fs.writeFileSync(path.join(alertDir, filename), message, 'utf-8');
  } catch (err) {
    logger.warn({ err, prefix }, 'alert-writer: failed to write alert file');
  }
}
