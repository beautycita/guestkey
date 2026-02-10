# GuestKey - Automated Rental Door Access Management

## Overview
Node.js background service that polls Airbnb iCal feed, auto-creates time-locked door codes on Ultraloq via Xthings API, WhatsApps the code to wife for forwarding to guest, and auto-deletes codes after checkout.

## Data Flow
1. iCal poller (every 15 min) detects new reservation
2. Generate random 6-digit code, check no duplicates among active codes
3. Xthings API: create temp user (type=2) with daterange check-in 3PM → check-out 11AM
4. WhatsApp wife (+523221215551) with booking code, access code, dates
5. Scheduler (hourly) finds expired bookings (checkout + 1hr buffer)
6. Xthings API: delete temp user from lock
7. WhatsApp wife: code expired notification
8. Log everything to SQLite

## Components
- `src/index.js` - Entry point, starts poller + scheduler + WhatsApp
- `src/xthings.js` - OAuth2 token mgmt + API wrapper
- `src/ical-poller.js` - Fetches/parses iCal, detects new bookings
- `src/lock-manager.js` - Create/delete temp users, generate codes
- `src/notifier.js` - WhatsApp Web client
- `src/scheduler.js` - Cleanup cron job
- `src/db.js` - SQLite schema + queries
- `src/cli.js` - Manual commands

## Database
- `reservations` table: id, guest_name, check_in, check_out, access_code, lock_user_id, ical_uid (unique), status, created_at
- `action_log` table: id, reservation_id, action, detail, timestamp
- `config` table: key/value store for tokens, lock MAC, settings

## OAuth2 Flow
- Auth code flow via oauth.u-tec.com
- Local redirect server on localhost:3000
- Tokens stored in SQLite config table
- Auto-refresh before expiry

## Single property, single lock. Standard 3PM in / 11AM out.
