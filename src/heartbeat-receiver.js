const http = require('http');
const fs = require('fs');
const path = require('path');

const HEARTBEAT_PORT = parseInt(process.env.HEARTBEAT_PORT || '3948', 10);
const HEARTBEAT_TOKEN = process.env.HEARTBEAT_TOKEN || '';
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(__dirname, '..', 'heartbeat.json');

let server = null;

function readHeartbeat() {
  try {
    const data = fs.readFileSync(HEARTBEAT_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeHeartbeat(payload) {
  const data = {
    node: payload.node,
    timestamp: payload.timestamp,
    receivedAt: new Date().toISOString(),
    activeReservations: payload.activeReservations,
    whatsappReady: payload.whatsappReady
  };
  fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(data, null, 2));
  return data;
}

function start() {
  return new Promise((resolve) => {
    const MAX_BODY = 4096;

    server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      // GET — return current heartbeat status (token required if configured)
      if (req.method === 'GET') {
        if (HEARTBEAT_TOKEN) {
          const auth = req.headers.authorization;
          const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
          if (auth !== `Bearer ${HEARTBEAT_TOKEN}` && urlToken !== HEARTBEAT_TOKEN) {
            res.writeHead(403);
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
          }
        }
        const hb = readHeartbeat();
        if (hb) {
          const gapMs = Date.now() - new Date(hb.timestamp).getTime();
          const gapHours = (gapMs / 3600000).toFixed(1);
          res.end(JSON.stringify({ ok: true, ...hb, gapHours }));
        } else {
          res.end(JSON.stringify({ ok: true, lastHeartbeat: null }));
        }
        return;
      }

      // POST — receive heartbeat
      if (req.method === 'POST') {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.writeHead(413);
            res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);

            // Validate token
            if (HEARTBEAT_TOKEN && payload.token !== HEARTBEAT_TOKEN) {
              res.writeHead(403);
              res.end(JSON.stringify({ ok: false, error: 'Invalid token' }));
              return;
            }

            const saved = writeHeartbeat(payload);
            res.end(JSON.stringify({ ok: true, received: saved }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    });

    server.listen(HEARTBEAT_PORT, '0.0.0.0', () => {
      console.log(`Heartbeat receiver on http://0.0.0.0:${HEARTBEAT_PORT}`);
      resolve(server);
    });
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop, readHeartbeat, writeHeartbeat };
