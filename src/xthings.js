const http = require('http');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const OAUTH_PORT = 9501;

function env(key) {
  return process.env[key];
}

// --- OAuth2 ---

async function authorize() {
  const clientId = env('XTHINGS_CLIENT_ID');
  const clientSecret = env('XTHINGS_CLIENT_SECRET');
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const state = uuidv4();

  const authUrl = `${env('XTHINGS_OAUTH_URL')}/authorize?response_type=code&client_id=${clientId}&client_secret=${clientSecret}&scope=openapi&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('authorization_code');
      const returnedState = url.searchParams.get('state');

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('State mismatch');
        reject(new Error('OAuth state mismatch'));
        server.close();
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('No authorization code received');
        reject(new Error('No authorization code'));
        server.close();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>GuestKey authorized! You can close this tab.</h1>');

      try {
        const tokens = await exchangeCode(code);
        server.close();
        resolve(tokens);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(OAUTH_PORT, () => {
      console.log(`OAuth callback server listening on port ${OAUTH_PORT}`);
      console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);

      import('open').then(({ default: open }) => {
        open(authUrl).catch(() => {
          console.log('Could not open browser automatically. Please open the URL above manually.');
        });
      });
    });

    server.on('error', (err) => {
      reject(new Error(`OAuth server failed to start on port ${OAUTH_PORT}: ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth authorization timed out (5 minutes)'));
    }, 5 * 60 * 1000);
  });
}

async function exchangeCode(code) {
  const clientId = env('XTHINGS_CLIENT_ID');
  const clientSecret = env('XTHINGS_CLIENT_SECRET');
  const tokenUrl = `${env('XTHINGS_OAUTH_URL')}/token?grant_type=authorization_code&client_id=${clientId}&client_secret=${clientSecret}&code=${code}`;

  const resp = await fetch(tokenUrl);
  const data = await resp.json();

  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error} - ${data.error_description || ''}`);
  }

  saveTokens(data);
  return data;
}

async function refreshToken() {
  const clientId = env('XTHINGS_CLIENT_ID');
  const clientSecret = env('XTHINGS_CLIENT_SECRET');
  const refresh = db.getConfig('refresh_token');

  if (!refresh) {
    throw new Error('No refresh token stored. Run "guestkey setup" first.');
  }

  const tokenUrl = `${env('XTHINGS_OAUTH_URL')}/token?grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refresh}`;

  const resp = await fetch(tokenUrl);
  const data = await resp.json();

  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error} - ${data.error_description || ''}`);
  }

  saveTokens(data);
  return data;
}

function saveTokens(data) {
  db.setConfig('access_token', data.access_token);
  if (data.refresh_token) {
    db.setConfig('refresh_token', data.refresh_token);
  }
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  db.setConfig('token_expires_at', String(expiresAt));
}

async function getAccessToken() {
  const expiresAt = parseInt(db.getConfig('token_expires_at') || '0', 10);
  const token = db.getConfig('access_token');

  if (!token) {
    throw new Error('No access token. Run "guestkey setup" first.');
  }

  // Refresh if expiring within 5 minutes
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    console.log('Access token expiring soon, refreshing...');
    await refreshToken();
    return db.getConfig('access_token');
  }

  return token;
}

// --- API Calls ---

async function apiCall(namespace, name, payload = {}) {
  const token = await getAccessToken();
  const messageId = uuidv4();

  const body = {
    header: {
      namespace,
      name,
      messageId,
      payloadVersion: '1'
    },
    payload
  };

  const resp = await fetch(env('XTHINGS_API_URL'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();

  if (data.payload?.error) {
    const err = data.payload.error;
    throw new Error(`Xthings API error: ${err.code} - ${err.message}`);
  }

  return data;
}

async function getUserInfo() {
  return apiCall('Uhome.User', 'Get');
}

async function discoverDevices() {
  return apiCall('Uhome.Device', 'Discovery');
}

async function queryDevice(deviceId) {
  return apiCall('Uhome.Device', 'Query', {
    devices: [{ id: deviceId }]
  });
}

async function sendCommand(deviceId, command) {
  return apiCall('Uhome.Device', 'Command', {
    devices: [{
      id: deviceId,
      command
    }]
  });
}

module.exports = {
  authorize, refreshToken, getAccessToken,
  apiCall, getUserInfo, discoverDevices, queryDevice, sendCommand,
  OAUTH_PORT
};
