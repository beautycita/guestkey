const { exec } = require('child_process');
const path = require('path');
const db = require('./db');

const LOCK_MODE = process.env.LOCK_MODE || 'ssh';
const LOCK_SCRIPT = process.env.LOCK_SCRIPT_PATH || '~/guestkey/air_lock.py';
const LOCK_VENV = process.env.LOCK_VENV_PATH ?? '~/beautycita-scraper/venv/bin/activate';
const BEAUTYPI_HOST = process.env.BEAUTYPI_HOST || 'dmyl@100.93.1.103';

const SSH_OPTIONS = '-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWithRetry(fn, maxRetries = 2, delayMs = 5000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt <= maxRetries) {
        console.log(`  Retry ${attempt}/${maxRetries} after error: ${err.message}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

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

    // Log command (sanitize sensitive args)
    const sanitized = args.replace(/--code\s+'[^']*'/g, "--code '***'");
    console.log(`  Lock script [${LOCK_MODE}]: air_lock.py ${sanitized}`);

    if (LOCK_MODE === 'local') {
      exec(cmd, { timeout: 180000, shell: '/bin/bash' }, callback);
    } else {
      const sshCmd = `ssh ${SSH_OPTIONS} ${BEAUTYPI_HOST} "${cmd.replace(/"/g, '\\"')}"`;
      exec(sshCmd, { timeout: 180000, shell: '/bin/bash' }, callback);
    }
  });
}

function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

async function addTempUser({ name, password, checkIn, checkOut }) {
  return runWithRetry(async () => {
    const args = `add --name ${shellEscape(name)} --code ${shellEscape(String(password))} --checkin ${shellEscape(checkIn)} --checkout ${shellEscape(checkOut)}`;
    const result = await runLockScript(args);

    if (!result.success) {
      throw new Error(result.error || `Failed to add user on lock (step: ${result.step || 'unknown'})`);
    }

    return result;
  }, 2, 5000);
}

async function deleteUser(userName) {
  return runWithRetry(async () => {
    const args = `delete --name ${shellEscape(userName)}`;
    const result = await runLockScript(args);

    if (!result.success) {
      throw new Error(result.error || 'Failed to delete user from lock');
    }

    return result;
  }, 2, 5000);
}

async function listUsers() {
  const result = await runLockScript('list');
  return result;
}

async function checkLockStatus() {
  const result = await runLockScript('list');
  return {
    count: result.count || 0,
    battery: result.battery || null
  };
}

module.exports = {
  generateCode, addTempUser, deleteUser, listUsers, checkLockStatus, runLockScript
};
