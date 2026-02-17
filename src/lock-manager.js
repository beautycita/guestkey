const { exec } = require('child_process');
const path = require('path');
const db = require('./db');

const LOCK_MODE = process.env.LOCK_MODE || 'ssh';
const LOCK_SCRIPT = process.env.LOCK_SCRIPT_PATH || '~/guestkey/air_lock.py';
const LOCK_VENV = process.env.LOCK_VENV_PATH ?? '~/beautycita-scraper/venv/bin/activate';
const BEAUTYPI_HOST = process.env.BEAUTYPI_HOST || 'dmyl@100.93.1.103';

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
 * Run air_lock.py — locally or via SSH depending on LOCK_MODE.
 * Returns parsed JSON result from the script.
 */
function runLockScript(args) {
  return new Promise((resolve, reject) => {
    const cmd = LOCK_VENV
      ? `source ${LOCK_VENV} && python3 ${LOCK_SCRIPT} ${args}`
      : `python3 ${LOCK_SCRIPT} ${args}`;

    const callback = (err, stdout, stderr) => {
      if (err) {
        const lines = (stdout || '').trim().split('\n');
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.success === false) {
              return reject(new Error(parsed.error || 'Unknown lock script error'));
            }
          } catch {}
        }
        return reject(new Error(`Lock script error: ${err.message}\n${stderr || ''}`));
      }

      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          return resolve(parsed);
        } catch {}
      }

      resolve({ success: true, raw: stdout.trim() });
    };

    if (LOCK_MODE === 'local') {
      exec(cmd, { timeout: 180000, shell: '/bin/bash' }, callback);
    } else {
      const sshCmd = `ssh -o ConnectTimeout=10 ${BEAUTYPI_HOST} "${cmd.replace(/"/g, '\\"')}"`;
      exec(sshCmd, { timeout: 180000, shell: '/bin/bash' }, callback);
    }
  });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

async function addTempUser({ name, password, checkIn, checkOut }) {
  const args = `add --name ${shellEscape(name)} --code ${shellEscape(String(password))} --checkin ${shellEscape(checkIn)} --checkout ${shellEscape(checkOut)}`;
  const result = await runLockScript(args);

  if (!result.success) {
    throw new Error(result.error || `Failed to add user on lock (step: ${result.step || 'unknown'})`);
  }

  return result;
}

async function deleteUser(userName) {
  const args = `delete --name ${shellEscape(userName)}`;
  const result = await runLockScript(args);

  if (!result.success) {
    throw new Error(result.error || 'Failed to delete user from lock');
  }

  return result;
}

async function listUsers() {
  const result = await runLockScript('list');
  return result;
}

module.exports = {
  generateCode, addTempUser, deleteUser, listUsers, runLockScript
};
