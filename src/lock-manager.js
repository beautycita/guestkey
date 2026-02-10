const { execFile, exec } = require('child_process');
const os = require('os');
const db = require('./db');

const BEAUTYPI_HOST = process.env.BEAUTYPI_HOST || 'dmyl@100.93.1.103';
const BEAUTYPI_SCRIPT = process.env.BEAUTYPI_SCRIPT || '~/guestkey/air_lock.py';
const BEAUTYPI_VENV = process.env.BEAUTYPI_VENV || '~/beautycita-scraper/venv/bin/activate';

// Detect if we're running on beautypi itself
const IS_LOCAL = os.hostname() === 'beautypi' || os.hostname().startsWith('beautypi');

function generateCode() {
  const activeCodes = db.getActiveCodes();
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    attempts++;
    if (attempts > 100) throw new Error('Failed to generate unique code after 100 attempts');
  } while (activeCodes.includes(code));
  return code;
}

/**
 * Run air_lock.py on beautypi - locally if on beautypi, via SSH otherwise.
 * Returns parsed JSON result from the script.
 */
function runOnBeautypi(args) {
  return new Promise((resolve, reject) => {
    const cmd = `source ${BEAUTYPI_VENV} && cd ~/guestkey && python3 ${BEAUTYPI_SCRIPT} ${args}`;

    const callback = (err, stdout, stderr) => {
      if (err) {
        // Try to extract JSON error from stdout
        const lines = (stdout || '').trim().split('\n');
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.success === false) {
              return reject(new Error(parsed.error || 'Unknown beautypi error'));
            }
          } catch {}
        }
        return reject(new Error(`SSH error: ${err.message}\n${stderr || ''}`));
      }

      // Find the JSON result line in stdout
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          return resolve(parsed);
        } catch {}
      }

      // No JSON found, return raw output
      resolve({ success: true, raw: stdout.trim() });
    };

    if (IS_LOCAL) {
      exec(cmd, { timeout: 120000, shell: '/bin/bash' }, callback);
    } else {
      execFile('ssh', ['-o', 'ConnectTimeout=10', BEAUTYPI_HOST, cmd], { timeout: 120000 }, callback);
    }
  });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

async function addTempUser({ name, password, checkIn, checkOut }) {
  const args = `add --name ${shellEscape(name)} --code ${shellEscape(String(password))} --checkin ${shellEscape(checkIn)} --checkout ${shellEscape(checkOut)}`;
  const result = await runOnBeautypi(args);

  if (!result.success) {
    throw new Error(result.error || 'Failed to add user on lock');
  }

  return result;
}

async function deleteUser(userName) {
  const args = `delete --name ${shellEscape(userName)}`;
  const result = await runOnBeautypi(args);

  if (!result.success) {
    throw new Error(result.error || 'Failed to delete user from lock');
  }

  return result;
}

async function listUsers() {
  const result = await runOnBeautypi('list');
  return result;
}

module.exports = {
  generateCode, addTempUser, deleteUser, listUsers, runOnBeautypi
};
