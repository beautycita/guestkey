const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const emailNotifier = require('./email-notifier');

const NOTIFY_METHOD = process.env.NOTIFY_METHOD || 'whatsapp';

let client = null;
let ready = false;

function getClient() {
  if (!client) {
    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '..', '.wwebjs_auth')
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      }
    });

    client.on('qr', (qr) => {
      console.log('\n========================================');
      console.log('  Scan this QR code with WhatsApp:');
      console.log('========================================');
      try {
        const qrcode = require('qrcode-terminal');
        qrcode.generate(qr, { small: true });
      } catch {
        console.log('QR Code:', qr);
        console.log('(Install qrcode-terminal for visual QR: npm i qrcode-terminal)');
      }
    });

    client.on('ready', () => {
      ready = true;
      console.log('WhatsApp client ready');
    });

    client.on('auth_failure', (msg) => {
      console.error('WhatsApp auth failed:', msg);
      ready = false;
    });

    client.on('disconnected', (reason) => {
      console.log('WhatsApp disconnected:', reason);
      ready = false;
    });
  }
  return client;
}

async function initialize() {
  if (NOTIFY_METHOD !== 'whatsapp') {
    console.log(`Notification method: ${NOTIFY_METHOD} (WhatsApp skipped)`);
    return;
  }

  const c = getClient();
  await c.initialize();
  if (!ready) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WhatsApp init timed out (2 minutes)')), 120000);
      c.once('ready', () => { clearTimeout(timeout); resolve(); });
    });
  }
}

function isReady() {
  if (NOTIFY_METHOD === 'email') return emailNotifier.isConfigured();
  return ready;
}

function formatNumber(number) {
  return number.replace(/\D/g, '') + '@c.us';
}

async function sendMessage(number, text) {
  if (NOTIFY_METHOD === 'email') {
    return emailNotifier.sendEmail('GuestKey Message', text);
  }

  if (!ready) {
    console.error('WhatsApp not ready, message not sent. Logging instead.');
    console.log(`[UNSENT MESSAGE to ${number}]:\n${text}`);
    return false;
  }

  try {
    const stripped = number.replace(/\D/g, '');
    const numberId = await client.getNumberId(stripped);
    if (!numberId) {
      console.error(`WhatsApp: number ${stripped} not found`);
      console.log(`[UNSENT MESSAGE to ${number}]:\n${text}`);
      return false;
    }
    await client.sendMessage(numberId._serialized, text);
    return true;
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    console.log(`[UNSENT MESSAGE to ${number}]:\n${text}`);
    return false;
  }
}

async function notifyNewCode(params) {
  if (NOTIFY_METHOD === 'email') {
    return emailNotifier.notifyNewCode(params);
  }

  const { guestName, accessCode, checkIn, checkOut, phoneLast4, reservationCode } = params;
  const wifeNumber = process.env.WHATSAPP_WIFE_NUMBER;
  const ownerNumber = process.env.WHATSAPP_NOTIFY_NUMBER;

  if (!wifeNumber && !ownerNumber) {
    console.error('No WhatsApp numbers configured');
    return false;
  }

  const fmtDate = (dt) => {
    const d = new Date(dt.replace(' ', 'T'));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const msg = [
    `Reservación Airbnb: ${reservationCode || guestName}`,
    `Código de puerta: *${accessCode}*`,
    `Entrada:  ${fmtDate(checkIn)}`,
    `Salida:   ${fmtDate(checkOut)}`
  ].join('\n');

  // Send to wife (pre-check-in notification)
  const target = wifeNumber || ownerNumber;
  return sendMessage(target, msg);
}

async function notifyCodeExpired(params) {
  if (NOTIFY_METHOD === 'email') {
    return emailNotifier.notifyCodeExpired(params);
  }

  const { guestName, reservationCode } = params;
  const number = process.env.WHATSAPP_NOTIFY_NUMBER;
  if (!number) return false;

  const msg = [
    `*GuestKey: Código Expirado*`,
    ``,
    `Reservación: ${reservationCode || guestName}`,
    `Código de acceso eliminado de la cerradura.`
  ].join('\n');

  return sendMessage(number, msg);
}

async function notifyError(message) {
  if (NOTIFY_METHOD === 'email') {
    return emailNotifier.notifyError(message);
  }

  const number = process.env.WHATSAPP_NOTIFY_NUMBER;
  if (!number) return false;
  return sendMessage(number, `*GuestKey Error:* ${message}`);
}

async function destroy() {
  if (client) {
    await client.destroy();
    client = null;
    ready = false;
  }
}

module.exports = {
  initialize, isReady, sendMessage,
  notifyNewCode, notifyCodeExpired, notifyError, destroy
};
