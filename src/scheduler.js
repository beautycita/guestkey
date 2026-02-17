const cron = require('node-cron');
const db = require('./db');
const lockManager = require('./lock-manager');
const notifier = require('./notifier');

async function cleanupExpired() {
  const bufferMinutes = parseInt(process.env.CLEANUP_BUFFER_MINUTES || '60', 10);
  const expired = db.getExpiredReservations(bufferMinutes);

  for (const res of expired) {
    console.log(`Cleaning up expired booking: ${res.reservation_code || res.guest_name}`);

    try {
      // Delete user from lock by name via beautypi
      await lockManager.deleteUser(res.guest_name);
      console.log(`  Deleted lock user ${res.guest_name}`);

      db.updateReservationStatus(res.id, 'expired');
      db.logAction(res.id, 'expired', 'Auto-cleanup after checkout + buffer');

      await notifier.notifyCodeExpired({
        guestName: res.guest_name,
        reservationCode: res.reservation_code
      });
    } catch (err) {
      console.error(`  Cleanup failed for ${res.reservation_code}: ${err.message}`);
      db.logAction(res.id, 'error', `Cleanup failed: ${err.message}`);
      try {
        await notifier.notifyError(`Cleanup failed for ${res.reservation_code}: ${err.message}`);
      } catch (notifyErr) {
        console.error(`  Error notification failed: ${notifyErr.message}`);
      }
    }
  }

  return expired.length;
}

async function checkBattery(onBatteryResult) {
  try {
    const status = await lockManager.checkLockStatus();
    const level = status.battery;
    if (!level) return;

    db.logBatteryCheck(level);
    if (onBatteryResult) onBatteryResult(level);

    if (level === 'Low') {
      // Check if we already sent an alert today
      const lastAlert = db.getLastBatteryAlert();
      if (lastAlert) {
        const hoursSince = (Date.now() - new Date(lastAlert).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 24) return; // Already alerted today
      }
      db.logBatteryAlert(level);
      try {
        await notifier.notifyError('Lock battery is LOW. Replace batteries soon.');
      } catch (e) {
        console.error('Battery alert notification failed:', e.message);
      }
      console.log('ALERT: Lock battery is LOW');
    } else {
      console.log(`Battery check: ${level}`);
    }
  } catch (err) {
    console.error('Battery check failed:', err.message);
  }
}

function startScheduler(sendPendingNotifications, recoverMissingLockUsers, onBatteryResult, onCleanupComplete) {
  // Run cleanup every hour at :05
  const task = cron.schedule('5 * * * *', async () => {
    try {
      const count = await cleanupExpired();
      if (count > 0) console.log(`Cleaned up ${count} expired booking(s)`);
      if (onCleanupComplete) onCleanupComplete();
    } catch (err) {
      console.error('Cleanup scheduler error:', err.message);
    }

    // Retry any missing lock users
    if (recoverMissingLockUsers) {
      try {
        const recovered = await recoverMissingLockUsers();
        if (recovered > 0) console.log(`Recovered ${recovered} missing lock user(s)`);
      } catch (err) {
        console.error('Lock recovery error:', err.message);
      }
    }

    // Check for pending notifications
    if (sendPendingNotifications) {
      try {
        const sent = await sendPendingNotifications();
        if (sent > 0) console.log(`Sent ${sent} pending notification(s)`);
      } catch (err) {
        console.error('Notification scheduler error:', err.message);
      }
    }
  });

  // Battery check once per day at noon
  const batteryTask = cron.schedule('0 12 * * *', async () => {
    await checkBattery(onBatteryResult);
  });

  console.log('Scheduler started (hourly at :05 — cleanup, lock recovery, notifications; daily at 12:00 — battery check)');
  return { stop: () => { task.stop(); batteryTask.stop(); } };
}

module.exports = { cleanupExpired, startScheduler, checkBattery };
