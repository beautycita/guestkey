#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('./db');
const lockManager = require('./lock-manager');
const notifier = require('./notifier');
const scheduler = require('./scheduler');
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
GuestKey - Automated Rental Door Access Management

Usage: guestkey <command> [options]

Commands:
  setup                     Test connectivity + WhatsApp QR
  run                       Start the background service
  status                    Show active codes
  list                      List all reservations
  add <name> <in> <out>     Manually add a booking (dates: YYYY-MM-DD)
  revoke <id>               Revoke an active code by reservation ID
  cleanup                   Run cleanup now (remove expired codes)
  users                     List all users currently on the lock
  `);
}

async function cmdSetup() {
  const index = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [index, 'setup'], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code));
}

async function cmdRun() {
  const index = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [index, 'run'], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code));
}

async function cmdStatus() {
  try {
    const active = db.getActiveReservations();
    console.log(`Active codes: ${active.length}`);
    for (const r of active) {
      console.log(`  [${r.id}] ${r.reservation_code || r.guest_name} | Code: ${r.access_code} | ${r.check_in} to ${r.check_out}`);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
  db.close();
}

async function cmdList() {
  const all = db.getAllReservations(50);
  if (all.length === 0) {
    console.log('No reservations found.');
  } else {
    console.log(`${'ID'.padStart(4)} | ${'Status'.padEnd(8)} | ${'Code'.padEnd(6)} | ${'Booking'.padEnd(12)} | ${'Check-in'.padEnd(16)} | Check-out`);
    console.log('-'.repeat(80));
    for (const r of all) {
      console.log(
        `${String(r.id).padStart(4)} | ${r.status.padEnd(8)} | ${r.access_code.padEnd(6)} | ${(r.reservation_code || r.guest_name).padEnd(12)} | ${r.check_in.padEnd(16)} | ${r.check_out}`
      );
    }
  }
  db.close();
}

async function cmdAdd() {
  const name = args[1];
  const checkInDate = args[2];
  const checkOutDate = args[3];

  if (!name || !checkInDate || !checkOutDate) {
    console.error('Usage: guestkey add <name> <check-in-date> <check-out-date>');
    console.error('  Dates in YYYY-MM-DD format');
    process.exit(1);
  }

  const checkinTime = process.env.DEFAULT_CHECKIN_TIME || '15:00';
  const checkoutTime = process.env.DEFAULT_CHECKOUT_TIME || '11:00';
  const checkIn = `${checkInDate} ${checkinTime}`;
  const checkOut = `${checkOutDate} ${checkoutTime}`;
  const guestName = `Guest-${name.substring(0, 6)}`;
  const code = lockManager.generateCode();

  console.log(`Adding manual booking:`);
  console.log(`  Guest:     ${guestName}`);
  console.log(`  Check-in:  ${checkIn}`);
  console.log(`  Check-out: ${checkOut}`);
  console.log(`  Code:      ${code}`);

  const resId = db.createReservation({
    guest_name: guestName,
    check_in: checkIn,
    check_out: checkOut,
    access_code: code,
    lock_user_id: null,
    ical_uid: null,
    phone_last4: '',
    reservation_code: `MANUAL-${name.substring(0, 6).toUpperCase()}`
  });

  db.logAction(resId, 'created', { manual: true, checkIn, checkOut, code });

  try {
    const result = await lockManager.addTempUser({
      name: guestName,
      password: code,
      checkIn,
      checkOut
    });
    db.logAction(resId, 'lock_user_created', result);
    console.log(`  Lock user created on air.ultraloq.com`);
  } catch (err) {
    console.error(`  Lock user creation failed: ${err.message}`);
    db.logAction(resId, 'error', err.message);
  }

  console.log('\nDone.');
  db.close();
}

async function cmdRevoke() {
  const id = parseInt(args[1], 10);
  if (!id) {
    console.error('Usage: guestkey revoke <reservation-id>');
    process.exit(1);
  }

  const reservations = db.getAllReservations(100);
  const res = reservations.find(r => r.id === id);

  if (!res) {
    console.error(`Reservation ${id} not found.`);
    process.exit(1);
  }

  if (res.status !== 'active') {
    console.error(`Reservation ${id} is already ${res.status}.`);
    process.exit(1);
  }

  console.log(`Revoking: ${res.reservation_code || res.guest_name} (code: ${res.access_code})`);

  try {
    await lockManager.deleteUser(res.guest_name);
    console.log(`  Lock user ${res.guest_name} deleted`);
  } catch (err) {
    console.error(`  Failed to delete lock user: ${err.message}`);
  }

  db.updateReservationStatus(id, 'revoked');
  db.logAction(id, 'revoked', 'Manual revocation via CLI');
  console.log('Done.');
  db.close();
}

async function cmdCleanup() {
  const count = await scheduler.cleanupExpired();
  console.log(`Cleaned up ${count} expired booking(s).`);
  db.close();
}

async function cmdUsers() {
  try {
    const result = await lockManager.listUsers();
    console.log(result.raw || JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
  db.close();
}

// Route commands
(async () => {
  switch (command) {
    case 'setup':   return cmdSetup();
    case 'run':     return cmdRun();
    case 'status':  return cmdStatus();
    case 'list':    return cmdList();
    case 'add':     return cmdAdd();
    case 'revoke':  return cmdRevoke();
    case 'cleanup': return cmdCleanup();
    case 'users':   return cmdUsers();
    default:        printUsage(); process.exit(0);
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
