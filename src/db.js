const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'guestkey.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_name   TEXT NOT NULL,
      check_in     TEXT NOT NULL,
      check_out    TEXT NOT NULL,
      access_code  TEXT NOT NULL,
      lock_user_id INTEGER,
      ical_uid     TEXT UNIQUE,
      phone_last4  TEXT,
      reservation_code TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER REFERENCES reservations(id),
      action         TEXT NOT NULL,
      detail         TEXT,
      timestamp      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
    CREATE INDEX IF NOT EXISTS idx_reservations_ical_uid ON reservations(ical_uid);
    CREATE INDEX IF NOT EXISTS idx_action_log_reservation ON action_log(reservation_id);
  `);
}

// --- Config ---

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  getDb().prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, value, value);
}

// --- Reservations ---

function getReservationByIcalUid(uid) {
  return getDb().prepare('SELECT * FROM reservations WHERE ical_uid = ?').get(uid);
}

function getActiveReservations() {
  return getDb().prepare("SELECT * FROM reservations WHERE status = 'active' ORDER BY check_in").all();
}

function getExpiredReservations(bufferMinutes) {
  const mins = parseInt(bufferMinutes, 10);
  if (isNaN(mins) || mins < 0) throw new Error(`Invalid bufferMinutes: ${bufferMinutes}`);
  return getDb().prepare(`
    SELECT * FROM reservations
    WHERE status = 'active'
    AND datetime(check_out, '+' || ? || ' minutes') < datetime('now', 'localtime')
  `).all(String(mins));
}

function getActiveCodes() {
  return getDb().prepare("SELECT access_code FROM reservations WHERE status = 'active'").all()
    .map(r => r.access_code);
}

function createReservation({ guest_name, check_in, check_out, access_code, lock_user_id, ical_uid, phone_last4, reservation_code }) {
  const result = getDb().prepare(`
    INSERT INTO reservations (guest_name, check_in, check_out, access_code, lock_user_id, ical_uid, phone_last4, reservation_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guest_name, check_in, check_out, access_code, lock_user_id, ical_uid, phone_last4, reservation_code);
  return result.lastInsertRowid;
}

function updateReservationStatus(id, status) {
  getDb().prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
}

function updateReservationLockUserId(id, lockUserId) {
  getDb().prepare('UPDATE reservations SET lock_user_id = ? WHERE id = ?').run(lockUserId, id);
}

function updateReservationDates(id, checkIn, checkOut) {
  getDb().prepare('UPDATE reservations SET check_in = ?, check_out = ? WHERE id = ?').run(checkIn, checkOut, id);
}

function getAllReservations(limit = 20) {
  return getDb().prepare('SELECT * FROM reservations ORDER BY created_at DESC LIMIT ?').all(limit);
}

// --- Action Log ---

function logAction(reservationId, action, detail) {
  getDb().prepare(
    'INSERT INTO action_log (reservation_id, action, detail) VALUES (?, ?, ?)'
  ).run(reservationId, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function getActionLog(reservationId) {
  return getDb().prepare(
    'SELECT * FROM action_log WHERE reservation_id = ? ORDER BY timestamp'
  ).all(reservationId);
}

// --- Error counting + cooldown ---

function getErrorCount(reservationId) {
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM action_log WHERE reservation_id = ? AND action = 'error'"
  ).get(reservationId);
  return row ? row.cnt : 0;
}

function getLastErrorTime(reservationId) {
  const row = getDb().prepare(
    "SELECT timestamp FROM action_log WHERE reservation_id = ? AND action = 'error' ORDER BY timestamp DESC LIMIT 1"
  ).get(reservationId);
  return row ? row.timestamp : null;
}

function getLastErrorNotifyTime(errorKey) {
  const row = getDb().prepare(
    "SELECT timestamp FROM action_log WHERE action = 'error_notified' AND detail = ? ORDER BY timestamp DESC LIMIT 1"
  ).get(errorKey);
  return row ? row.timestamp : null;
}

function logErrorNotify(errorKey) {
  getDb().prepare(
    "INSERT INTO action_log (action, detail) VALUES ('error_notified', ?)"
  ).run(errorKey);
}

function markReservationFailed(id) {
  getDb().prepare("UPDATE reservations SET status = 'failed' WHERE id = ?").run(id);
}

function getLastBatteryAlert() {
  const row = getDb().prepare(
    "SELECT timestamp FROM action_log WHERE action = 'battery_alert' ORDER BY timestamp DESC LIMIT 1"
  ).get();
  return row ? row.timestamp : null;
}

function logBatteryCheck(level) {
  getDb().prepare(
    "INSERT INTO action_log (action, detail) VALUES ('battery_check', ?)"
  ).run(level);
}

function logBatteryAlert(level) {
  getDb().prepare(
    "INSERT INTO action_log (action, detail) VALUES ('battery_alert', ?)"
  ).run(level);
}

// Active reservations that never got a lock_user_created action (interrupted or failed)
// Excludes status='failed' (gave up after max retries)
function getReservationsNeedingLockUser() {
  return getDb().prepare(`
    SELECT r.* FROM reservations r
    WHERE r.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM action_log a
      WHERE a.reservation_id = r.id AND a.action = 'lock_user_created'
    )
    ORDER BY r.check_in
  `).all();
}

// Active reservations within hours of check-in that haven't been successfully notified yet
// Excludes status='failed'
function getReservationsNeedingNotification(hoursBeforeCheckin) {
  const hours = parseInt(hoursBeforeCheckin, 10);
  if (isNaN(hours) || hours < 0) throw new Error(`Invalid hoursBeforeCheckin: ${hoursBeforeCheckin}`);
  return getDb().prepare(`
    SELECT r.* FROM reservations r
    WHERE r.status = 'active'
    AND datetime(r.check_in, '-' || ? || ' hours') <= datetime('now', 'localtime')
    AND NOT EXISTS (
      SELECT 1 FROM action_log a
      WHERE a.reservation_id = r.id
      AND a.action = 'notified'
      AND a.detail LIKE '%"whatsapp":true%'
    )
    ORDER BY r.check_in
  `).all(String(hours));
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb, getConfig, setConfig,
  getReservationByIcalUid, getActiveReservations, getExpiredReservations,
  getActiveCodes, createReservation, updateReservationStatus, updateReservationLockUserId, updateReservationDates,
  getAllReservations, logAction, getActionLog,
  getReservationsNeedingLockUser, getReservationsNeedingNotification,
  getErrorCount, getLastErrorTime, getLastErrorNotifyTime, logErrorNotify,
  markReservationFailed,
  getLastBatteryAlert, logBatteryCheck, logBatteryAlert,
  close
};
