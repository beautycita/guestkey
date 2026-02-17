#!/usr/bin/env node
/**
 * GuestKey Standby — entry point for secondary/tertiary nodes.
 *
 * Always runs: heartbeat receiver + watchdog.
 * When primary is down for WATCHDOG_THRESHOLD_HOURS, activates full GuestKey service.
 * When primary recovers, deactivates and returns to dormant mode.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const db = require('./db');
const heartbeatReceiver = require('./heartbeat-receiver');
const watchdog = require('./watchdog');
const service = require('./index');

const NODE_NAME = process.env.NODE_NAME || 'standby';
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(__dirname, '..', 'heartbeat.json');
const THRESHOLD_HOURS = parseInt(process.env.WATCHDOG_THRESHOLD_HOURS || '20', 10);
const CHECK_INTERVAL = parseInt(process.env.WATCHDOG_CHECK_INTERVAL_MS || '300000', 10);

async function main() {
  console.log(`=== GuestKey Standby (${NODE_NAME}) ===\n`);

  // Always run heartbeat receiver
  await heartbeatReceiver.start();

  // Start watchdog
  watchdog.start({
    heartbeatFile: HEARTBEAT_FILE,
    thresholdHours: THRESHOLD_HOURS,
    checkIntervalMs: CHECK_INTERVAL,

    onActivate: async () => {
      console.log('\n=== FAILOVER: Starting GuestKey service ===\n');
      await service.startService();
      console.log('\nGuestKey standby is now ACTIVE.\n');
    },

    onDeactivate: async () => {
      console.log('\n=== FAILOVER: Stopping GuestKey service ===\n');
      await service.stopService();
      console.log('\nGuestKey standby is now DORMANT.\n');
    }
  });

  console.log(`\nStandby node '${NODE_NAME}' is DORMANT. Monitoring primary heartbeat.\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down standby...');
    watchdog.stop();
    heartbeatReceiver.stop();
    if (watchdog.isActive()) {
      await service.stopService();
    }
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Standby startup failed:', err);
  process.exit(1);
});
