const db = require('./db');
const notifier = require('./notifier');

const HEARTBEAT_URL = process.env.HEARTBEAT_URL;
const HEARTBEAT_TOKEN = process.env.HEARTBEAT_TOKEN || '';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '600000', 10); // 10 min
const NODE_NAME = process.env.NODE_NAME || 'unknown';

let interval = null;

async function sendHeartbeat() {
  if (!HEARTBEAT_URL) return;

  const payload = {
    node: NODE_NAME,
    timestamp: new Date().toISOString(),
    activeReservations: db.getActiveReservations().length,
    whatsappReady: notifier.isReady(),
    token: HEARTBEAT_TOKEN
  };

  try {
    const resp = await fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      console.error(`Heartbeat POST failed: ${resp.status}`);
    }
  } catch (err) {
    // Non-fatal — primary doesn't depend on secondary
    console.error(`Heartbeat send error: ${err.message}`);
  }
}

function start() {
  if (!HEARTBEAT_URL) {
    console.log('Heartbeat sender: disabled (no HEARTBEAT_URL)');
    return null;
  }

  console.log(`Heartbeat sender: ${HEARTBEAT_URL} every ${HEARTBEAT_INTERVAL / 1000}s`);
  sendHeartbeat(); // Send immediately
  interval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  return interval;
}

function stop() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

module.exports = { start, stop, sendHeartbeat };
