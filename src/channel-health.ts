import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

/** How often to run the health check for all channels (ms). */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Number of consecutive failures before a critical alert is written. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Per-channel failure tracking state.
 */
interface ChannelHealthState {
  consecutiveFailures: number;
  alertWritten: boolean;
}

/**
 * Write a channel-health alert file so the main process (or Ulterior) can
 * pick it up.  Files are named with channel name + timestamp so multiple
 * alerts don't overwrite each other.
 */
function writeAlertFile(channelName: string, message: string): void {
  try {
    const alertDir = path.join(DATA_DIR, 'alerts');
    fs.mkdirSync(alertDir, { recursive: true });
    const filename = `channel-health-${channelName}-${Date.now()}.txt`;
    fs.writeFileSync(path.join(alertDir, filename), message, 'utf-8');
  } catch (err) {
    logger.warn(
      { err, channelName },
      'channel-health: failed to write alert file',
    );
  }
}

/**
 * Run a single health-check pass over all provided channels.
 * Updates the state map in place and writes alert files when a channel
 * has been unhealthy for MAX_CONSECUTIVE_FAILURES consecutive checks.
 */
async function runHealthChecks(
  channels: Channel[],
  state: Map<string, ChannelHealthState>,
): Promise<void> {
  for (const channel of channels) {
    let channelState = state.get(channel.name);
    if (!channelState) {
      channelState = { consecutiveFailures: 0, alertWritten: false };
      state.set(channel.name, channelState);
    }

    let healthy: boolean;
    try {
      healthy = await channel.healthCheck();
    } catch (err) {
      logger.warn(
        { err, channel: channel.name },
        'channel-health: healthCheck threw',
      );
      healthy = false;
    }

    if (healthy) {
      if (channelState.consecutiveFailures > 0) {
        logger.info(
          { channel: channel.name },
          'channel-health: channel recovered',
        );
      }
      channelState.consecutiveFailures = 0;
      channelState.alertWritten = false;
    } else {
      channelState.consecutiveFailures++;
      logger.warn(
        {
          channel: channel.name,
          consecutiveFailures: channelState.consecutiveFailures,
        },
        'channel-health: channel unhealthy',
      );

      if (
        channelState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        !channelState.alertWritten
      ) {
        const msg =
          `CRITICAL: Channel "${channel.name}" has failed ${channelState.consecutiveFailures} ` +
          `consecutive health checks. Manual intervention may be required.`;
        logger.error(
          {
            channel: channel.name,
            consecutiveFailures: channelState.consecutiveFailures,
          },
          'channel-health: channel has exceeded failure threshold',
        );
        writeAlertFile(channel.name, msg);
        channelState.alertWritten = true;
      }
    }
  }
}

/**
 * Start the periodic channel health monitor.
 * Should be called once during application startup, after channels are
 * connected.
 *
 * @param getChannels - Callback returning the current list of active channels.
 *   Called at each interval so dynamically-added channels are included.
 */
export function startChannelHealthMonitor(getChannels: () => Channel[]): void {
  const state = new Map<string, ChannelHealthState>();

  logger.info(
    {
      intervalMs: HEALTH_CHECK_INTERVAL_MS,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    },
    'channel-health: monitor started',
  );

  const loop = async () => {
    try {
      await runHealthChecks(getChannels(), state);
    } catch (err) {
      logger.warn({ err }, 'channel-health: error during health check pass');
    }
    setTimeout(loop, HEALTH_CHECK_INTERVAL_MS);
  };

  // First check is deferred by one full interval to let channels finish
  // their initial connect() before we start probing them.
  setTimeout(loop, HEALTH_CHECK_INTERVAL_MS);
}
