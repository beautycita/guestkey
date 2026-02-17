#!/bin/bash
# GuestKey — Deployment script for secondary/tertiary nodes
# Run this on the target server to set up GuestKey standby.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== GuestKey Standby Installation ==="
echo "Directory: $SCRIPT_DIR"
echo ""

# 1. Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first."
  exit 1
fi
echo "Node.js: $(node -v)"

# 2. Check Python 3
if ! command -v python3 &> /dev/null; then
  echo "ERROR: Python 3 not found. Install python3 first:"
  echo "  sudo apt install python3 python3-pip python3-venv"
  exit 1
fi
echo "Python: $(python3 --version)"

# 3. Create Python venv + install Playwright
VENV_DIR="$SCRIPT_DIR/venv"
if [ ! -d "$VENV_DIR" ]; then
  echo ""
  echo "Creating Python venv..."
  python3 -m venv "$VENV_DIR"
fi

echo "Installing Playwright..."
source "$VENV_DIR/bin/activate"
pip install --quiet playwright
playwright install chromium
playwright install-deps 2>/dev/null || echo "(playwright install-deps may need sudo — run manually if needed)"
deactivate

# 4. Install Node.js dependencies
echo ""
echo "Installing Node.js dependencies..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -3

# 5. Create directories
mkdir -p "$SCRIPT_DIR/browser_state"
mkdir -p "$SCRIPT_DIR/screenshots"
mkdir -p "$SCRIPT_DIR/logs"

# 6. Create .env template if not exists
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo ""
  echo "Creating .env template..."
  cat > "$SCRIPT_DIR/.env" << 'ENVTEMPLATE'
# GuestKey Standby Configuration
# Fill in the values below before starting.

# iCal feeds (same as primary)
AIRBNB_ICAL_URL=
BOOKING_ICAL_URL=

# Ultraloq credentials (same as primary)
ULTRALOQ_EMAIL=
ULTRALOQ_PASSWORD=

# Check-in/out times
DEFAULT_CHECKIN_TIME=15:00
DEFAULT_CHECKOUT_TIME=11:00
CLEANUP_BUFFER_MINUTES=60

# Lock mode — always 'local' for standby nodes
LOCK_MODE=local
LOCK_SCRIPT_PATH=./air_lock.py
LOCK_VENV_PATH=./venv/bin/activate

# Notification method — 'email' for standby nodes
NOTIFY_METHOD=email
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=
EMAIL_SMTP_PASS=
EMAIL_TO=
EMAIL_FROM=GuestKey Standby <guestkey@example.com>

# Heartbeat
HEARTBEAT_TOKEN=
HEARTBEAT_PORT=3948
HEARTBEAT_FILE=./heartbeat.json

# Watchdog
WATCHDOG_THRESHOLD_HOURS=20
WATCHDOG_CHECK_INTERVAL_MS=300000

# Node identity
NODE_NAME=standby
GUEST_NAME_PREFIX=S-

# Database
DB_PATH=./guestkey.db

# Trigger server
TRIGGER_PORT=3947
TRIGGER_BIND=127.0.0.1
ENVTEMPLATE
  echo "  Created $SCRIPT_DIR/.env — edit it with your values."
else
  echo ".env already exists — not overwriting."
fi

# 7. Test air_lock.py
echo ""
echo "Testing air_lock.py (requires ULTRALOQ_EMAIL and ULTRALOQ_PASSWORD in .env)..."
if [ -n "$(grep 'ULTRALOQ_EMAIL=.' "$SCRIPT_DIR/.env")" ]; then
  source "$VENV_DIR/bin/activate"
  set -a; source "$SCRIPT_DIR/.env"; set +a
  python3 "$SCRIPT_DIR/air_lock.py" list 2>&1 | tail -3
  deactivate
else
  echo "  Skipped — ULTRALOQ_EMAIL not set in .env yet."
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your credentials and iCal URLs"
echo "  2. Test: node src/standby.js"
echo "  3. For PM2: pm2 start src/standby.js --name guestkey-standby"
echo "  4. Add nginx proxy: location /guestkey/ { proxy_pass http://127.0.0.1:3948/; }"
echo "  5. On primary, add HEARTBEAT_URL and HEARTBEAT_TOKEN to .env"
echo ""
