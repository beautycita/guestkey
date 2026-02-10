const db = require('./db');
const lockManager = require('./lock-manager');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function parseIcal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const event = {};

    // Extract UID
    const uidMatch = block.match(/^UID:(.+)$/m);
    if (uidMatch) event.uid = uidMatch[1].trim();

    // Extract SUMMARY
    const summaryMatch = block.match(/^SUMMARY:(.+)$/m);
    if (summaryMatch) event.summary = summaryMatch[1].trim();

    // Extract DTSTART (DATE only format: YYYYMMDD)
    const startMatch = block.match(/^DTSTART;VALUE=DATE:(\d{8})$/m);
    if (startMatch) event.startDate = startMatch[1];

    // Extract DTEND (DATE only format: YYYYMMDD)
    const endMatch = block.match(/^DTEND;VALUE=DATE:(\d{8})$/m);
    if (endMatch) event.endDate = endMatch[1];

    // Extract DESCRIPTION (may be multi-line with continuation lines starting with space)
    const descLines = [];
    const lines = block.split('\n');
    let inDesc = false;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r/g, '');
      if (line.startsWith('DESCRIPTION:')) {
        inDesc = true;
        descLines.push(line.substring('DESCRIPTION:'.length));
      } else if (inDesc && line.startsWith(' ')) {
        descLines.push(line.substring(1));
      } else {
        inDesc = false;
      }
    }
    const desc = descLines.join('').replace(/\\n/g, '\n').trim();

    // Extract reservation code from URL
    const codeMatch = desc.match(/\/details\/(\w+)/);
    if (codeMatch) event.reservationCode = codeMatch[1];

    // Extract phone last 4
    const phoneMatch = desc.match(/Phone Number \(Last 4 Digits\):\s*(\d{4})/);
    if (phoneMatch) event.phoneLast4 = phoneMatch[1];

    event.description = desc;
    events.push(event);
  }

  return events;
}

function formatDate(icalDate, time) {
  // icalDate is "YYYYMMDD", time is "HH:mm"
  const y = icalDate.substring(0, 4);
  const m = icalDate.substring(4, 6);
  const d = icalDate.substring(6, 8);
  return `${y}-${m}-${d} ${time}`;
}

async function fetchIcal() {
  const url = process.env.AIRBNB_ICAL_URL;
  if (!url) throw new Error('AIRBNB_ICAL_URL not set in .env');

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iCal fetch failed: ${resp.status}`);
  return resp.text();
}

async function pollOnce(onNewBooking) {
  const checkinTime = process.env.DEFAULT_CHECKIN_TIME || '15:00';
  const checkoutTime = process.env.DEFAULT_CHECKOUT_TIME || '11:00';

  const text = await fetchIcal();
  const events = parseIcal(text);

  const reservations = events.filter(e =>
    e.summary === 'Reserved' && e.uid && e.startDate && e.endDate
  );

  let newCount = 0;

  for (const res of reservations) {
    // Skip if already in DB
    const existing = db.getReservationByIcalUid(res.uid);
    if (existing) continue;

    const checkIn = formatDate(res.startDate, checkinTime);
    const checkOut = formatDate(res.endDate, checkoutTime);
    const guestName = `Guest-${(res.reservationCode || '').substring(0, 6)}`;
    const code = lockManager.generateCode();

    const booking = {
      guestName,
      checkIn,
      checkOut,
      accessCode: code,
      icalUid: res.uid,
      phoneLast4: res.phoneLast4 || '',
      reservationCode: res.reservationCode || ''
    };

    if (onNewBooking) {
      await onNewBooking(booking);
    }

    newCount++;
  }

  // Check for cancelled bookings (UID in DB but not in iCal anymore)
  const activeReservations = db.getActiveReservations();
  const icalUids = new Set(events.map(e => e.uid));

  for (const active of activeReservations) {
    if (active.ical_uid && !icalUids.has(active.ical_uid)) {
      console.log(`Booking ${active.reservation_code} appears cancelled (UID gone from iCal)`);
      // Don't auto-revoke - just log it. User can manually revoke.
      db.logAction(active.id, 'cancellation_detected', 'iCal UID no longer present');
    }
  }

  return newCount;
}

function startPolling(onNewBooking) {
  console.log('iCal polling started (every 15 minutes)');

  // Poll immediately on start
  pollOnce(onNewBooking).then(count => {
    if (count > 0) console.log(`Found ${count} new booking(s) on startup`);
  }).catch(err => {
    console.error('iCal poll error:', err.message);
  });

  // Then poll every 15 minutes
  const interval = setInterval(() => {
    pollOnce(onNewBooking).then(count => {
      if (count > 0) console.log(`Found ${count} new booking(s)`);
    }).catch(err => {
      console.error('iCal poll error:', err.message);
    });
  }, POLL_INTERVAL_MS);

  return interval;
}

module.exports = { parseIcal, fetchIcal, pollOnce, startPolling, formatDate };
