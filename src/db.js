const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'guestkey.db');

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
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER REFERENCES reservations(id),
      action         TEXT NOT NULL,
      detail         TEXT,
      timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
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
  return getDb().prepare(`
    SELECT * FROM reservations
    WHERE status = 'active'
    AND datetime(check_out, '+${bufferMinutes} minutes') < datetime('now')
  `).all();
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

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb, getConfig, setConfig,
  getReservationByIcalUid, getActiveReservations, getExpiredReservations,
  getActiveCodes, createReservation, updateReservationStatus, updateReservationLockUserId,
  getAllReservations, logAction, getActionLog, close
};
