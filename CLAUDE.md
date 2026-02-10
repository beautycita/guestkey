# GuestKey - Automated Rental Door Access Management

## Project Purpose
Automate temporary access code creation/deletion for Ultraloq WiFi deadbolts on rental properties. When an Airbnb booking comes in via iCal, auto-generate a 6-digit code, set it on the lock via Playwright browser automation on air.ultraloq.com, send WhatsApp notification in Spanish, and clean up after checkout.

## Architecture

### How It Works
1. **iCal Poller** checks Airbnb calendar every 15 minutes for new reservations
2. **Code Generator** creates unique 6-digit codes (no collisions with active codes)
3. **Lock Manager** calls `air_lock.py` on beautypi (Playwright automation) to add/delete temp users on the lock
4. **WhatsApp Notifier** sends code + dates to notification number via whatsapp-web.js
5. **Cleanup Scheduler** runs hourly, removes expired codes 60 min after checkout

### Why Playwright (not OpenAPI)
- Devices on **Ultraloq Air** (air.ultraloq.com) are NOT visible to the Xthings OpenAPI
- Air and OpenAPI are separate device registries
- Playwright browser automation on air.ultraloq.com is the only way to manage Air-connected locks
- air.ultraloq.com has direct email/password login (not Google OAuth)

### Lock: "Front Door" at "211A Alazan" (U-Bolt-Pro-WiFi)

## Deployment

### beautypi (Raspberry Pi, production host)
- Tailscale IP: `100.93.1.103`, user: `dmyl`
- Service: `sudo systemctl {start|stop|restart|status} guestkey`
- Logs: `sudo journalctl -u guestkey -f`
- Project: `~/guestkey/`
- Playwright automation: `~/guestkey/air_lock.py`
- Playwright venv: `~/beautycita-scraper/venv/`
- Browser state: `~/guestkey/browser_state/state.json`
- Screenshots: `~/guestkey/screenshots/`
- WhatsApp auth: `~/guestkey/.wwebjs_auth/`

### Local development (WSL2)
- Project: `/home/bc/guestkey/`
- When running locally, lock-manager SSHes to beautypi
- When running on beautypi, lock-manager detects hostname and runs locally

### Syncing to beautypi
```bash
rsync -avz --exclude node_modules --exclude .wwebjs_auth --exclude '*.db*' /home/bc/guestkey/ dmyl@100.93.1.103:~/guestkey/
```

## Key Files
- `src/index.js` - Main service (iCal polling + cleanup + WhatsApp)
- `src/cli.js` - CLI commands (status, list, add, revoke, cleanup, users)
- `src/lock-manager.js` - Calls air_lock.py locally or via SSH
- `src/notifier.js` - WhatsApp notifications (Spanish, uses getNumberId for MX numbers)
- `src/scheduler.js` - Hourly cleanup of expired codes
- `src/ical-poller.js` - Airbnb iCal feed parser
- `src/db.js` - SQLite database
- `src/xthings.js` - Xthings OpenAPI client (kept for reference, not used in production)
- `docs/ops-guide.md` - Operations guide with troubleshooting

## Credentials
Stored in `.env` (git-ignored):
- `AIRBNB_ICAL_URL` - Airbnb calendar feed
- `WHATSAPP_NOTIFY_NUMBER` - WhatsApp notification recipient
- `BEAUTYPI_HOST` - SSH target for lock automation
- `BEAUTYPI_SCRIPT` - Path to air_lock.py on beautypi
- `BEAUTYPI_VENV` - Path to Python venv on beautypi
- `DEFAULT_CHECKIN_TIME` / `DEFAULT_CHECKOUT_TIME` - Default times
- `CLEANUP_BUFFER_MINUTES` - Buffer after checkout before code removal

## air.ultraloq.com UI Flow (Add Temp User)
1. Login with email/password
2. User menu > Add User > fill name, code, role=Guest > Save
3. Add Device Access > click "Front Door" row (NOT checkbox, hidden in headless) > Next Step
4. Change User Type dropdown to "Temporary User"
5. Set Begin Time (MM/DD/YYYY HH:mm) and End Time
6. Click Done > I Know confirmation

## Tech Stack
- Node.js v18 (on beautypi)
- SQLite (better-sqlite3)
- whatsapp-web.js + system Chromium (ARM)
- Playwright + Chromium (for lock automation)
- node-cron (scheduler)
- systemd (service management)

## References
- Xthings OpenAPI docs: `docs/postman-collection.json`
- Operations guide: `docs/ops-guide.md`
