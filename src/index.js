require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const db = require('./db');
const lockManager = require('./lock-manager');
const icalPoller = require('./ical-poller');
const notifier = require('./notifier');
const scheduler = require('./scheduler');
const heartbeatSender = require('./heartbeat-sender');

const NOTIFY_HOURS_BEFORE = parseInt(process.env.NOTIFY_HOURS_BEFORE || '26', 10);
const TRIGGER_PORT = parseInt(process.env.TRIGGER_PORT || '3947', 10);
const TRIGGER_BIND = process.env.TRIGGER_BIND || '127.0.0.1';

// --- Service state ---
let pollInterval = null;
let schedulerTask = null;
let triggerServer = null;

async function handleNewBooking(booking) {
  const { guestName, checkIn, checkOut, accessCode, icalUid, phoneLast4, reservationCode } = booking;

  console.log(`\nNew booking detected: ${reservationCode || guestName}`);
  console.log(`  Check-in:  ${checkIn}`);
  console.log(`  Check-out: ${checkOut}`);
  console.log(`  Code:      ${accessCode}`);

  const resId = db.createReservation({
    guest_name: guestName,
    check_in: checkIn,
    check_out: checkOut,
    access_code: accessCode,
    lock_user_id: null,
    ical_uid: icalUid,
    phone_last4: phoneLast4,
    reservation_code: reservationCode
  });

  db.logAction(resId, 'created', { reservationCode, checkIn, checkOut, accessCode });

  await ensureLockUser({ id: resId, guest_name: guestName, access_code: accessCode, check_in: checkIn, check_out: checkOut, reservation_code: reservationCode });
}

async function ensureLockUser(res) {
  try {
    const result = await lockManager.addTempUser({
      name: res.guest_name,
      password: res.access_code,
      checkIn: res.check_in,
      checkOut: res.check_out
    });

    db.logAction(res.id, 'lock_user_created', result);
    console.log(`  Lock user created: ${res.guest_name}`);
  } catch (err) {
    console.error(`  Failed to create lock user for ${res.reservation_code || res.guest_name}: ${err.message}`);
    db.logAction(res.id, 'error', `Lock user creation failed: ${err.message}`);
  }
}

async function recoverMissingLockUsers() {
  const missing = db.getReservationsNeedingLockUser();
  if (missing.length === 0) return 0;

  console.log(`Recovery: ${missing.length} reservation(s) missing lock users`);
  for (const res of missing) {
    console.log(`  Retrying lock user for ${res.reservation_code || res.guest_name}...`);
    await ensureLockUser(res);
  }
  return missing.length;
}

async function sendNotificationForReservation(res) {
  const ok = await notifier.notifyNewCode({
    guestName: res.guest_name,
    accessCode: res.access_code,
    checkIn: res.check_in,
    checkOut: res.check_out,
    phoneLast4: res.phone_last4,
    reservationCode: res.reservation_code
  });
  db.logAction(res.id, 'notified', { whatsapp: ok });
  return ok;
}

async function sendPendingNotifications() {
  const pending = db.getReservationsNeedingNotification(NOTIFY_HOURS_BEFORE);
  if (pending.length === 0) return 0;

  let sent = 0;
  for (const res of pending) {
    console.log(`Sending notification for ${res.reservation_code || res.guest_name} (check-in: ${res.check_in})`);
    try {
      const ok = await sendNotificationForReservation(res);
      if (ok) {
        console.log(`  Notification sent for ${res.reservation_code}`);
        sent++;
      } else {
        console.log(`  Notification unavailable for ${res.reservation_code}`);
      }
    } catch (err) {
      console.error(`  Notification failed for ${res.reservation_code}: ${err.message}`);
      db.logAction(res.id, 'error', `Notification failed: ${err.message}`);
    }
  }
  return sent;
}

// --- Local HTTP trigger ---
function startTriggerServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    try {
      if (req.method === 'GET' && req.url === '/status') {
        const active = db.getActiveReservations();
        const waReady = notifier.isReady();
        res.end(JSON.stringify({ ok: true, whatsapp: waReady, activeReservations: active.length }));
        return;
      }

      if (req.method === 'POST' && req.url === '/notify/all') {
        const count = await sendPendingNotifications();
        res.end(JSON.stringify({ ok: true, sent: count }));
        return;
      }

      const notifyMatch = req.url.match(/^\/notify\/(\d+)$/);
      if (req.method === 'POST' && notifyMatch) {
        const id = parseInt(notifyMatch[1], 10);
        const reservation = db.getDb().prepare('SELECT * FROM reservations WHERE id = ?').get(id);
        if (!reservation) {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: 'Reservation not found' }));
          return;
        }
        console.log(`Trigger: sending notification for ${reservation.reservation_code || reservation.guest_name}`);
        const ok = await sendNotificationForReservation(reservation);
        res.end(JSON.stringify({ ok, whatsapp: ok, reservation: reservation.reservation_code, code: reservation.access_code }));
        return;
      }

      if (req.method === 'POST' && req.url === '/send') {
        const body = await readBody(req);
        const { number, text } = JSON.parse(body);
        if (!number || !text) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'number and text required' }));
          return;
        }
        const ok = await notifier.sendMessage(number, text);
        res.end(JSON.stringify({ ok, sent: ok }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('Trigger server error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  server.listen(TRIGGER_PORT, TRIGGER_BIND, () => {
    console.log(`Trigger server on http://${TRIGGER_BIND}:${TRIGGER_PORT}`);
  });

  return server;
}

function readBody(req, maxSize = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Payload too large')); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

// --- Exported service lifecycle ---

async function startService() {
  console.log('Connecting to notification service...');
  try {
    await notifier.initialize();
    console.log('Notification service ready.\n');
  } catch (err) {
    console.error('Notification service failed to connect:', err.message);
    console.log('Continuing without notifications — messages will log to console.\n');
  }

  try {
    const recovered = await recoverMissingLockUsers();
    if (recovered > 0) console.log(`Recovered ${recovered} missing lock user(s)`);
  } catch (err) {
    console.error('Recovery error:', err.message);
  }

  pollInterval = icalPoller.startPolling(handleNewBooking);
  schedulerTask = scheduler.startScheduler(sendPendingNotifications, recoverMissingLockUsers);

  const cleaned = await scheduler.cleanupExpired();
  if (cleaned > 0) console.log(`Cleaned up ${cleaned} expired booking(s) on startup`);

  try {
    const notified = await sendPendingNotifications();
    if (notified > 0) console.log(`Sent ${notified} pending notification(s) on startup`);
  } catch (err) {
    console.error('Notification check error:', err.message);
  }

  triggerServer = startTriggerServer();
  heartbeatSender.start();
}

async function stopService() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (schedulerTask) { schedulerTask.stop(); schedulerTask = null; }
  if (triggerServer) { triggerServer.close(); triggerServer = null; }
  heartbeatSender.stop();
  await notifier.destroy();
}

// --- Setup command ---

async function setup() {
  console.log('=== GuestKey Setup ===\n');

  console.log('Step 1: Testing lock connection...');
  try {
    const result = await lockManager.listUsers();
    console.log(`Connected! Found ${result.count || 0} users on lock.\n`);
  } catch (err) {
    console.error('Lock connection failed:', err.message);
    process.exit(1);
  }

  console.log('Step 2: Testing iCal feeds...');
  try {
    const text = await icalPoller.fetchUrl(process.env.AIRBNB_ICAL_URL);
    const events = icalPoller.parseIcal(text);
    const reservations = events.filter(e => e.summary === 'Reserved');
    console.log(`Airbnb OK: ${reservations.length} reservation(s)`);
  } catch (err) {
    console.error('Airbnb iCal failed:', err.message);
  }
  if (process.env.BOOKING_ICAL_URL) {
    try {
      const text = await icalPoller.fetchUrl(process.env.BOOKING_ICAL_URL);
      const events = icalPoller.parseIcal(text);
      console.log(`Booking.com OK: ${events.length} event(s)\n`);
    } catch (err) {
      console.error('Booking.com iCal failed:', err.message);
    }
  }

  console.log('Step 3: Setting up notifications...');
  try {
    await notifier.initialize();
    console.log('\nNotification service connected!\n');
  } catch (err) {
    console.error('Notification setup failed:', err.message);
    console.log('You can still use GuestKey — messages will be logged to console instead.\n');
  }

  console.log('\n=== Setup Complete ===');
  await notifier.destroy();
  db.close();
}

// --- Main entry ---

async function run() {
  console.log('=== GuestKey Service Starting ===\n');

  try {
    await lockManager.listUsers();
    console.log('Lock: connected');
  } catch (err) {
    console.error('Lock unreachable:', err.message);
    console.log('Will retry on each operation.\n');
  }

  await startService();

  console.log('\nGuestKey is running. Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    console.log('\nShutting down...');
    await stopService();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const command = process.argv[2];
if (command === 'setup') {
  setup().catch(err => { console.error(err); process.exit(1); });
} else if (command === 'run') {
  run().catch(err => { console.error(err); process.exit(1); });
} else {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  startService, stopService, handleNewBooking,
  sendPendingNotifications, recoverMissingLockUsers
};
