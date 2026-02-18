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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`iCal fetch failed (${url}): ${resp.status}`);
    return resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function pollOnce({ onNewBooking, onCancellation, onDateChange }) {
  const checkinTime = process.env.DEFAULT_CHECKIN_TIME || '15:00';
  const checkoutTime = process.env.DEFAULT_CHECKOUT_TIME || '11:00';

  let newCount = 0;
  let airbnbOk = false;
  let bookingOk = false;
  const feedEvents = new Map(); // uid -> { startDate, endDate }

  // --- Airbnb ---
  const airbnbUrl = process.env.AIRBNB_ICAL_URL;
  if (airbnbUrl) {
    try {
      const text = await fetchUrl(airbnbUrl);
      const events = parseIcal(text);
      airbnbOk = true;
      events.forEach(e => { if (e.uid) feedEvents.set(e.uid, { startDate: e.startDate, endDate: e.endDate }); });

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
      bookingOk = true;
      events.forEach(e => { if (e.uid) feedEvents.set(e.uid, { startDate: e.startDate, endDate: e.endDate }); });

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

  // --- Cancellation + date change detection ---
  const activeReservations = db.getActiveReservations();
  for (const active of activeReservations) {
    if (!active.ical_uid) continue;

    // Determine source from guest_name prefix
    const isAirbnb = active.guest_name.includes('Airbnb-');
    const isBooking = active.guest_name.includes('Booking-');
    const sourceFeedOk = (isAirbnb && airbnbOk) || (isBooking && bookingOk);

    // Skip if the source feed failed — can't distinguish cancellation from fetch error
    if (!sourceFeedOk) continue;

    const feedEvent = feedEvents.get(active.ical_uid);

    if (!feedEvent) {
      // UID missing from feed — possible cancellation
      // Require 2 consecutive detections >10 min apart before acting
      const prevDetection = db.getDb().prepare(
        "SELECT timestamp FROM action_log WHERE reservation_id = ? AND action = 'cancellation_detected' ORDER BY timestamp DESC LIMIT 1"
      ).get(active.id);

      if (prevDetection) {
        const minutesSince = (Date.now() - new Date(prevDetection.timestamp).getTime()) / (1000 * 60);
        if (minutesSince >= 10) {
          // Confirmed cancellation
          console.log(`Booking ${active.reservation_code} confirmed cancelled (UID gone from 2 consecutive polls)`);
          if (onCancellation) await onCancellation(active);
        }
        // else: too recent, wait for next poll
      } else {
        // First detection — log warning only
        console.log(`Booking ${active.reservation_code} may be cancelled (UID gone from iCal, awaiting confirmation)`);
        db.logAction(active.id, 'cancellation_detected', 'iCal UID no longer present');
      }
    } else {
      // UID still in feed — check for date changes
      const newCheckIn = formatDate(feedEvent.startDate, checkinTime);
      const newCheckOut = formatDate(feedEvent.endDate, checkoutTime);

      if (newCheckIn !== active.check_in || newCheckOut !== active.check_out) {
        console.log(`Booking ${active.reservation_code} dates changed: ${active.check_in}→${newCheckIn}, ${active.check_out}→${newCheckOut}`);
        if (onDateChange) await onDateChange(active, newCheckIn, newCheckOut);
      }
    }
  }

  return newCount;
}

function startPolling({ onNewBooking, onPollComplete, onCancellation, onDateChange } = {}) {
  console.log('iCal polling started (every 15 minutes)');

  const callbacks = { onNewBooking, onCancellation, onDateChange };

  pollOnce(callbacks).then(count => {
    if (count > 0) console.log(`Found ${count} new booking(s) on startup`);
    if (onPollComplete) onPollComplete();
  }).catch(err => {
    console.error('iCal poll error:', err.message);
  });

  const interval = setInterval(() => {
    pollOnce(callbacks).then(count => {
      if (count > 0) console.log(`Found ${count} new booking(s)`);
      if (onPollComplete) onPollComplete();
    }).catch(err => {
      console.error('iCal poll error:', err.message);
    });
  }, POLL_INTERVAL_MS);

  return interval;
}

module.exports = { parseIcal, fetchUrl, pollOnce, startPolling, formatDate };
