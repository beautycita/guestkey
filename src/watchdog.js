const fs = require('fs');
const emailNotifier = require('./email-notifier');

const NODE_NAME = process.env.NODE_NAME || 'standby';

let checkInterval = null;
let active = false;
let callbacks = { onActivate: null, onDeactivate: null };

function getHeartbeatAge(heartbeatFile) {
  try {
    const data = fs.readFileSync(heartbeatFile, 'utf8');
    const hb = JSON.parse(data);
    const gapMs = Date.now() - new Date(hb.timestamp).getTime();
    return { gapMs, gapHours: gapMs / 3600000, heartbeat: hb };
  } catch {
    return { gapMs: Infinity, gapHours: Infinity, heartbeat: null };
  }
}

function start(opts) {
  const {
    heartbeatFile,
    thresholdHours = 20,
    checkIntervalMs = 300000, // 5 minutes
    onActivate,
    onDeactivate
  } = opts;

  callbacks = { onActivate, onDeactivate };

  console.log(`Watchdog: monitoring ${heartbeatFile} (threshold: ${thresholdHours}h, check: ${checkIntervalMs / 1000}s)`);

  const check = async () => {
    const { gapHours, heartbeat } = getHeartbeatAge(heartbeatFile);

    if (!active && gapHours >= thresholdHours) {
      // Primary down for too long — ACTIVATE
      active = true;
      const msg = heartbeat
        ? `Primary '${heartbeat.node}' last heartbeat ${gapHours.toFixed(1)}h ago (${heartbeat.timestamp}). Threshold: ${thresholdHours}h.`
        : `No heartbeat file found. Assuming primary is down.`;

      console.log(`WATCHDOG: ACTIVATING — ${msg}`);

      try {
        await emailNotifier.sendAlert(
          `${NODE_NAME} ACTIVATED — primary down`,
          `GuestKey standby node '${NODE_NAME}' is now ACTIVE.\n\n${msg}\n\nLock user creation and email notifications are now running from this node.`
        );
      } catch (err) {
        console.error('Watchdog: activation email failed:', err.message);
      }

      if (callbacks.onActivate) {
        try {
          await callbacks.onActivate();
        } catch (err) {
          console.error('Watchdog: activation callback error:', err.message);
        }
      }
    } else if (active && gapHours < thresholdHours) {
      // Primary recovered — DEACTIVATE
      active = false;
      const msg = `Primary '${heartbeat.node}' heartbeat received ${gapHours.toFixed(1)}h ago (${heartbeat.timestamp}). Deactivating standby.`;

      console.log(`WATCHDOG: DEACTIVATING — ${msg}`);

      if (callbacks.onDeactivate) {
        try {
          await callbacks.onDeactivate();
        } catch (err) {
          console.error('Watchdog: deactivation callback error:', err.message);
        }
      }

      try {
        await emailNotifier.sendAlert(
          `${NODE_NAME} DEACTIVATED — primary recovered`,
          `GuestKey standby node '${NODE_NAME}' is now DORMANT.\n\n${msg}\n\nPrimary has resumed operations.`
        );
      } catch (err) {
        console.error('Watchdog: deactivation email failed:', err.message);
      }
    }
  };

  // Check immediately, then on interval
  check();
  checkInterval = setInterval(check, checkIntervalMs);
  return checkInterval;
}

function stop() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

function isActive() {
  return active;
}

module.exports = { start, stop, isActive, getHeartbeatAge };
