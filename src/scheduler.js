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
      await notifier.notifyError(`Cleanup failed for ${res.reservation_code}: ${err.message}`);
    }
  }

  return expired.length;
}

function startScheduler() {
  // Run cleanup every hour at :05
  const task = cron.schedule('5 * * * *', async () => {
    try {
      const count = await cleanupExpired();
      if (count > 0) console.log(`Cleaned up ${count} expired booking(s)`);
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  });

  console.log('Cleanup scheduler started (runs hourly at :05)');
  return task;
}

module.exports = { cleanupExpired, startScheduler };
