# GuestKey Operations Guide

Quick reference for managing the GuestKey automated door access system on beautypi.

**Host:** beautypi (Tailscale: `100.93.1.103`, user: `dmyl`, sudo: `JUs3f2m3Fa`)

---

## Service Management

Service: `guestkey` (systemd, auto-starts on boot, restarts on failure after 30s)

```bash
sudo systemctl start guestkey
sudo systemctl stop guestkey
sudo systemctl restart guestkey
sudo systemctl status guestkey
sudo journalctl -u guestkey -f          # live logs
sudo journalctl -u guestkey -n 100      # last 100 lines
```

---

## WhatsApp Recovery

When WhatsApp loses authentication (session expired, device unlinked):

1. RustDesk into beautypi
2. `sudo systemctl stop guestkey`
3. `rm -rf ~/guestkey/.wwebjs_auth`
4. `screen -dmS guestkey node ~/guestkey/src/index.js run`
5. `screen -r guestkey` -- scan the QR code with WhatsApp (Linked Devices > Link a Device)
6. Once it says "WhatsApp ready", detach with `Ctrl+A D`
7. `screen -S guestkey -X quit`
8. `sudo systemctl start guestkey`

---

## CLI Commands

Run from beautypi: `cd ~/guestkey && node src/cli.js <command>`

| Command | Description |
|---------|-------------|
| `status` | Show active codes |
| `list` | List all reservations |
| `add <name> <checkin> <checkout>` | Add booking manually (dates: YYYY-MM-DD) |
| `revoke <id>` | Revoke active code by reservation ID |
| `cleanup` | Run expired code cleanup now |
| `users` | List users currently on the lock |

---

## Architecture

| Component | Details |
|-----------|---------|
| iCal polling | Every 15 min from Airbnb |
| Cleanup scheduler | Hourly at :05, removes expired codes 60 min after checkout |
| Lock control | Playwright browser automation on air.ultraloq.com (local on beautypi) |
| WhatsApp | whatsapp-web.js using system Chromium |
| Database | SQLite at `~/guestkey/guestkey.db` |

---

## Troubleshooting

**beautypi unreachable**
```bash
tailscale status
```

**Lock automation fails**
Check screenshots at `~/guestkey/screenshots/`. If air.ultraloq.com session expired, delete browser state to force re-login:
```bash
rm -rf ~/guestkey/browser_state/state.json
```

**WhatsApp "No LID for user"**
Number format issue -- `getNumberId` resolves automatically. No action needed unless persistent.

**Service won't start**
```bash
sudo journalctl -u guestkey -n 50
```

**Chromium crash / stale lock**
```bash
sudo killall -9 chromium-browser
rm -f ~/guestkey/.wwebjs_auth/session/SingletonLock
sudo systemctl restart guestkey
```
