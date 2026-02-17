const db = require('./db');
const lockManager = require('./lock-manager');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseIcal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const event = {};

    const uidMatch = block.match(/^UID:(.+)$/m);
    if (uidMatch) event.uid = uidMatch[1].trim();

    const summaryMatch = block.match(/^SUMMARY:(.+)$/m);
    if (summaryMatch) event.summary = summaryMatch[1].trim();

    const startMatch = block.match(/^DTSTART;VALUE=DATE:(\d{8})$/m);
    if (startMatch) event.startDate = startMatch[1];

    const endMatch = block.match(/^DTEND;VALUE=DATE:(\d{8})$/m);
    if (endMatch) event.endDate = endMatch[1];

    // Multi-line DESCRIPTION
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

    const codeMatch = desc.match(/\/details\/(\w+)/);
    if (codeMatch) event.reservationCode = codeMatch[1];

    const phoneMatch = desc.match(/Phone Number \(Last 4 Digits\):\s*(\d{4})/);
    if (phoneMatch) event.phoneLast4 = phoneMatch[1];

    event.description = desc;
    events.push(event);
  }

  return events;
}

// "20260214" -> "Feb14"
function shortDate(icalDate) {
  const m = parseInt(icalDate.substring(4, 6), 10) - 1;
  const d = icalDate.substring(6, 8);
  return `${MONTH_NAMES[m]}${d}`;
}

function formatDate(icalDate, time) {
  const y = icalDate.substring(0, 4);
  const m = icalDate.substring(4, 6);
  const d = icalDate.substring(6, 8);
  return `${y}-${m}-${d} ${time}`;
}

async function fetchUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iCal fetch failed (${url}): ${resp.status}`);
  return resp.text();
}

async function pollOnce(onNewBooking) {
  const checkinTime = process.env.DEFAULT_CHECKIN_TIME || '15:00';
  const checkoutTime = process.env.DEFAULT_CHECKOUT_TIME || '11:00';

  let newCount = 0;
  const allFeedUids = new Set();

  // --- Airbnb ---
  const airbnbUrl = process.env.AIRBNB_ICAL_URL;
  if (airbnbUrl) {
    try {
      const text = await fetchUrl(airbnbUrl);
      const events = parseIcal(text);
      events.forEach(e => { if (e.uid) allFeedUids.add(e.uid); });

      const reservations = events.filter(e =>
        e.summary === 'Reserved' && e.uid && e.startDate && e.endDate
      );

      for (const res of reservations) {
        if (db.getReservationByIcalUid(res.uid)) continue;

        const checkIn = formatDate(res.startDate, checkinTime);
        const checkOut = formatDate(res.endDate, checkoutTime);
        const prefix = process.env.GUEST_NAME_PREFIX || '';
        const guestName = `${prefix}Airbnb-${shortDate(res.startDate)}`;
        const code = lockManager.generateCode();

        if (onNewBooking) await onNewBooking({
          guestName,
          checkIn,
          checkOut,
          accessCode: code,
          icalUid: res.uid,
          phoneLast4: res.phoneLast4 || '',
          reservationCode: res.reservationCode || '',
          source: 'airbnb'
        });
        newCount++;
      }
    } catch (err) {
      console.error('Airbnb iCal poll error:', err.message);
    }
  }

  // --- Booking.com ---
  const bookingUrl = process.env.BOOKING_ICAL_URL;
  if (bookingUrl) {
    try {
      const text = await fetchUrl(bookingUrl);
      const events = parseIcal(text);
      events.forEach(e => { if (e.uid) allFeedUids.add(e.uid); });

      for (const ev of events) {
        if (!ev.uid || !ev.startDate || !ev.endDate) continue;
        if (db.getReservationByIcalUid(ev.uid)) continue;

        const checkIn = formatDate(ev.startDate, checkinTime);
        const checkOut = formatDate(ev.endDate, checkoutTime);
        const prefix = process.env.GUEST_NAME_PREFIX || '';
        const guestName = `${prefix}Booking-${shortDate(ev.startDate)}`;
        const code = lockManager.generateCode();

        if (onNewBooking) await onNewBooking({
          guestName,
          checkIn,
          checkOut,
          accessCode: code,
          icalUid: ev.uid,
          phoneLast4: '',
          reservationCode: `Booking-${shortDate(ev.startDate)}`,
          source: 'booking'
        });
        newCount++;
      }
    } catch (err) {
      console.error('Booking.com iCal poll error:', err.message);
    }
  }

  // Check for cancelled bookings (UID in DB but gone from feeds)
  const activeReservations = db.getActiveReservations();
  for (const active of activeReservations) {
    if (active.ical_uid && !allFeedUids.has(active.ical_uid)) {
      console.log(`Booking ${active.reservation_code} appears cancelled (UID gone from iCal)`);
      db.logAction(active.id, 'cancellation_detected', 'iCal UID no longer present');
    }
  }

  return newCount;
}

function startPolling(onNewBooking) {
  console.log('iCal polling started (every 15 minutes)');

  pollOnce(onNewBooking).then(count => {
    if (count > 0) console.log(`Found ${count} new booking(s) on startup`);
  }).catch(err => {
    console.error('iCal poll error:', err.message);
  });

  const interval = setInterval(() => {
    pollOnce(onNewBooking).then(count => {
      if (count > 0) console.log(`Found ${count} new booking(s)`);
    }).catch(err => {
      console.error('iCal poll error:', err.message);
    });
  }, POLL_INTERVAL_MS);

  return interval;
}

module.exports = { parseIcal, fetchUrl, pollOnce, startPolling, formatDate };
