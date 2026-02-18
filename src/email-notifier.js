const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
      secure: false,
      auth: {
        user: process.env.EMAIL_SMTP_USER,
        pass: process.env.EMAIL_SMTP_PASS
      }
    });
  }
  return transporter;
}

function isConfigured() {
  return !!(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS && process.env.EMAIL_TO);
}

async function sendEmail(subject, text) {
  if (!isConfigured()) {
    console.error('Email not configured (EMAIL_SMTP_USER, EMAIL_SMTP_PASS, EMAIL_TO required)');
    console.log(`[UNSENT EMAIL] ${subject}\n${text}`);
    return false;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || `GuestKey <${process.env.EMAIL_SMTP_USER}>`,
      to: process.env.EMAIL_TO,
      subject,
      text
    });
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    console.log(`[UNSENT EMAIL] ${subject}\n${text}`);
    return false;
  }
}

function fmtDate(dt) {
  const d = new Date(dt.replace(' ', 'T'));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function notifyNewCode({ guestName, accessCode, checkIn, checkOut, phoneLast4, reservationCode }) {
  const subject = `GuestKey: Nuevo codigo - ${reservationCode || guestName}`;
  const text = [
    `Reservacion: ${reservationCode || guestName}`,
    `Codigo de puerta: ${accessCode}`,
    `Entrada:  ${fmtDate(checkIn)}`,
    `Salida:   ${fmtDate(checkOut)}`
  ].join('\n');

  return sendEmail(subject, text);
}

async function notifyCodeExpired({ guestName, reservationCode }) {
  const subject = `GuestKey: Codigo Expirado - ${reservationCode || guestName}`;
  const text = [
    `Reservacion: ${reservationCode || guestName}`,
    `Codigo de acceso eliminado de la cerradura.`
  ].join('\n');

  return sendEmail(subject, text);
}

async function notifyCancellation({ guestName, reservationCode, accessCode }) {
  const subject = `GuestKey: Cancelada - ${reservationCode || guestName}`;
  const text = [
    `Reservacion: ${reservationCode || guestName}`,
    `Codigo de acceso ${accessCode} revocado de la cerradura.`
  ].join('\n');

  return sendEmail(subject, text);
}

async function notifyDateChange({ guestName, reservationCode, accessCode, oldCheckIn, oldCheckOut, newCheckIn, newCheckOut }) {
  const subject = `GuestKey: Fechas Modificadas - ${reservationCode || guestName}`;
  const text = [
    `Reservacion: ${reservationCode || guestName}`,
    `Codigo: ${accessCode}`,
    ``,
    `Antes:  ${fmtDate(oldCheckIn)} - ${fmtDate(oldCheckOut)}`,
    `Ahora:  ${fmtDate(newCheckIn)} - ${fmtDate(newCheckOut)}`
  ].join('\n');

  return sendEmail(subject, text);
}

async function notifyError(message) {
  return sendEmail('GuestKey Error', message);
}

async function sendAlert(subject, body) {
  return sendEmail(`GuestKey Alert: ${subject}`, body);
}

module.exports = {
  sendEmail, notifyNewCode, notifyCodeExpired, notifyCancellation, notifyDateChange, notifyError, sendAlert, isConfigured
};
