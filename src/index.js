require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('./db');
const lockManager = require('./lock-manager');
const icalPoller = require('./ical-poller');
const notifier = require('./notifier');
const scheduler = require('./scheduler');

async function handleNewBooking(booking) {
  const { guestName, checkIn, checkOut, accessCode, icalUid, phoneLast4, reservationCode } = booking;

  console.log(`\nNew booking detected: ${reservationCode || guestName}`);
  console.log(`  Check-in:  ${checkIn}`);
  console.log(`  Check-out: ${checkOut}`);
  console.log(`  Code:      ${accessCode}`);

  // Save to DB first
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

  // Create temp user on lock via beautypi
  try {
    const result = await lockManager.addTempUser({
      name: guestName,
      password: accessCode,
      checkIn,
      checkOut
    });

    db.logAction(resId, 'lock_user_created', result);
    console.log(`  Lock user created on air.ultraloq.com`);
  } catch (err) {
    console.error(`  Failed to create lock user: ${err.message}`);
    db.logAction(resId, 'error', `Lock user creation failed: ${err.message}`);
    await notifier.notifyError(`Failed to create code for ${reservationCode}: ${err.message}`);
  }

  // Send WhatsApp notification
  try {
    const sent = await notifier.notifyNewCode({
      guestName,
      accessCode,
      checkIn,
      checkOut,
      phoneLast4,
      reservationCode
    });
    db.logAction(resId, 'notified', { whatsapp: sent });
    if (sent) console.log(`  WhatsApp notification sent`);
  } catch (err) {
    console.error(`  WhatsApp notification failed: ${err.message}`);
    db.logAction(resId, 'error', `WhatsApp failed: ${err.message}`);
  }
}

async function setup() {
  console.log('=== GuestKey Setup ===\n');

  // Step 1: Verify beautypi connectivity
  console.log('Step 1: Testing beautypi connection...');
  try {
    const result = await lockManager.listUsers();
    console.log(`Connected! Found ${result.count || 0} users on lock.\n`);
  } catch (err) {
    console.error('beautypi connection failed:', err.message);
    console.error('Make sure beautypi is online and SSH key is configured.');
    process.exit(1);
  }

  // Step 2: Verify iCal feed
  console.log('Step 2: Testing iCal feed...');
  try {
    const text = await icalPoller.fetchIcal();
    const events = icalPoller.parseIcal(text);
    const reservations = events.filter(e => e.summary === 'Reserved');
    console.log(`iCal OK: ${reservations.length} active reservation(s)\n`);
  } catch (err) {
    console.error('iCal feed failed:', err.message);
    process.exit(1);
  }

  // Step 3: WhatsApp
  console.log('Step 3: Setting up WhatsApp...');
  console.log('(Scan QR code with your WhatsApp)\n');
  try {
    await notifier.initialize();
    console.log('\nWhatsApp connected!\n');

    const testSent = await notifier.sendMessage(
      process.env.WHATSAPP_NOTIFY_NUMBER,
      '*GuestKey Setup Complete!*\nYou will receive booking codes here.'
    );
    if (testSent) console.log('Test message sent to notification number.');
  } catch (err) {
    console.error('WhatsApp setup failed:', err.message);
    console.log('You can still use GuestKey - messages will be logged to console instead.\n');
  }

  console.log('\n=== Setup Complete ===');
  console.log('Run "guestkey run" to start the service.');

  await notifier.destroy();
  db.close();
}

async function run() {
  console.log('=== GuestKey Service Starting ===\n');

  // Verify beautypi is reachable
  try {
    await lockManager.listUsers();
    console.log('beautypi: connected');
  } catch (err) {
    console.error('beautypi unreachable:', err.message);
    console.log('Will retry on each operation.\n');
  }

  // Initialize WhatsApp
  console.log('Connecting to WhatsApp...');
  try {
    await notifier.initialize();
    console.log('WhatsApp ready.\n');
  } catch (err) {
    console.error('WhatsApp failed to connect:', err.message);
    console.log('Continuing without WhatsApp - messages will log to console.\n');
  }

  // Start iCal polling
  const pollInterval = icalPoller.startPolling(handleNewBooking);

  // Start cleanup scheduler
  const schedulerTask = scheduler.startScheduler();

  // Also run cleanup immediately on start
  const cleaned = await scheduler.cleanupExpired();
  if (cleaned > 0) console.log(`Cleaned up ${cleaned} expired booking(s) on startup`);

  console.log('\nGuestKey is running. Press Ctrl+C to stop.\n');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    clearInterval(pollInterval);
    schedulerTask.stop();
    await notifier.destroy();
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(pollInterval);
    schedulerTask.stop();
    await notifier.destroy();
    db.close();
    process.exit(0);
  });
}

const command = process.argv[2];
if (command === 'setup') {
  setup().catch(err => { console.error(err); process.exit(1); });
} else if (command === 'run') {
  run().catch(err => { console.error(err); process.exit(1); });
} else {
  run().catch(err => { console.error(err); process.exit(1); });
}
