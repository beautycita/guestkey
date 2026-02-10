# GuestKey - Automated Rental Door Access Management

## Project Purpose
Automate temporary access code creation/deletion for Xthings (Ultraloq) WiFi deadbolts on rental properties. When a rental booking comes in, auto-generate a 6-digit code, set check-in/check-out windows, deliver code to guest via Airbnb messaging, and clean up after checkout.

## Xthings / U-tec OpenAPI Reference

### OAuth2 Authorization Code Flow
- **Auth server:** `https://oauth.u-tec.com`
- **API server:** `https://api.u-tec.com`
- **Scope:** `openapi`

#### Step 1 - Authorization URL (open in browser)
```
https://oauth.u-tec.com/authorize?response_type=code&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&scope=openapi&redirect_uri={REDIRECT_URI}&state={STATE}
```

#### Step 2 - Callback receives authorization code
```
https://{REDIRECT_URI}?authorization_code={CODE}&state={STATE}
```

#### Step 3 - Exchange code for access token
```
GET https://oauth.u-tec.com/token?grant_type=authorization_code&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&code={CODE}
```
Returns: `access_token`, `refresh_token`, `expires_in`

#### Step 4 - Refresh token
```
GET https://oauth.u-tec.com/token?grant_type=refresh_token&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&refresh_token={REFRESH_TOKEN}
```

### API Request Format
All API calls: `POST https://api.u-tec.com/action`

**Authentication** (pick one):
- Header: `Authorization: Bearer <ACCESS_TOKEN>`
- Body: `"authentication": { "type": "Bearer", "token": "<ACCESS_TOKEN>" }`

**Envelope:**
```json
{
  "header": {
    "namespace": "Uhome.Device",
    "name": "Command",
    "messageId": "<UUID v4>",
    "payloadVersion": "1"
  },
  "payload": { ... }
}
```

Response mirrors the header; errors in `payload.error` with `code` + `message`.

### API Endpoints (all POST /action)

| Namespace | Name | Purpose |
|-----------|------|---------|
| Uhome.User | Get | Get current user info |
| Uhome.User | Logout | Unlink user |
| Uhome.Device | Discovery | List all devices (returns id, name, category, model) |
| Uhome.Device | Query | Query device status (lock state, battery, door sensor) |
| Uhome.Device | Command | Send command to device (lock, unlock, user mgmt, switch) |
| Uhome.Configure | Set | Register notification webhook URL |

### Device Discovery
```json
{
  "header": { "namespace": "Uhome.Device", "name": "Discovery", "messageId": "<uuid>", "payloadVersion": "1" },
  "payload": {}
}
```
Response: `payload.devices[]` with `id` (MAC address), `name`, `category`, `handleType`, `deviceInfo`, `attributes`

### Query Device Status
```json
{
  "payload": {
    "devices": [{ "id": "<MAC>" }]
  }
}
```
Response: `payload.devices[].states[]` with `capability`, `name`, `value`
- `st.lock` / `lockState`: Locked|Unlocked|Jammed|Unknown
- `st.BatteryLevel` / `level`: 1-5
- `st.DoorSensor` / `sensorState`: Closed|Open|Unknown

### Lock Control
```json
{
  "payload": {
    "devices": [{
      "id": "<MAC>",
      "command": { "capability": "st.lock", "name": "lock" }
    }]
  }
}
```
Commands: `lock`, `unlock`
Response: `st.deferredResponse` with `seconds` (async, result comes via notification)

### Lock User Management (st.lockUser)
**List all users:**
```json
{ "command": { "capability": "st.lockUser", "name": "list" } }
```
Response: `payload.devices[].users[]` with `id`, `name`, `type`, `status`, `sync_status`

**Get user details:**
```json
{ "command": { "capability": "st.lockUser", "name": "get", "id": 12345 } }
```
Response: `payload.devices[].user` with `id`, `name`, `type`, `status`, `sync_status`, `password`

**Add user:**
```json
{
  "command": {
    "capability": "st.lockUser",
    "name": "add",
    "user": {
      "name": "Guest Name",
      "type": 2,
      "password": 123456,
      "daterange": ["2024-07-01 15:00", "2024-07-03 11:00"],
      "weeks": [0,1,2,3,4,5,6],
      "timerange": ["00:00", "23:59"],
      "limit": 0
    }
  }
}
```

**User types:** 0=Normal, 1=Owner(?), 2=Temporary, 3=Admin

**Temporary user fields:**
- `name`: string
- `type`: 2 (temporary)
- `password`: 4-8 digit integer (the door code)
- `daterange`: ["YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm"] (check-in, check-out)
- `weeks`: [0-6] (0=Sunday through 6=Saturday, which days allowed)
- `timerange`: ["HH:mm", "HH:mm"] (daily window)
- `limit`: integer (0=unlimited unlocks)

**Update user** (add `id` field to user object):
```json
{ "command": { "capability": "st.lockUser", "name": "update", "user": { "id": 12345, ... } } }
```

**Delete user:**
```json
{ "command": { "capability": "st.lockUser", "name": "delete", "id": 12345 } }
```

### Deferred Responses
Lock commands (lock/unlock, add/update/delete user) return `st.deferredResponse` with `seconds` value. The actual result arrives asynchronously via the registered notification webhook.

### Register Notification Webhook
```json
{
  "header": { "namespace": "Uhome.Configure", "name": "Set", "messageId": "<uuid>", "payloadVersion": "1" },
  "payload": {
    "configure": {
      "notification": {
        "access_token": "<token for push auth>",
        "url": "https://your-server.com/callback"
      }
    }
  }
}
```

## API Access Status

### Developer Account (PENDING)
- Submitted request at developer.xthings.com on 2026-02-06
- Account email: securesession.live@gmail.com
- Waiting for U-tec to activate Developer Console

### Once Approved - Setup Steps
1. Open Xthings Home app → Settings → Developer Console
2. Note the `client_id` and `client_secret`
3. Set redirect URI to: `http://localhost:9847/callback`
4. Set scope to: `openapi`
5. Update `.env` with the new credentials
6. Run `guestkey setup`

### Key Learnings from Auth Debugging
- The "Activate OpenAPI" toggle in the app generates credentials, but these are NOT valid OAuth client_ids until U-tec activates the Developer Account
- OAuth server: `oauth.u-tec.com` (NOT `api.u-tec.com/oauth2/`)
- The login page at oauth.u-tec.com uses AJAX: POST `/login/chklogin` then `/login/accept`
- Ultraloq Air (air.ultraloq.com) may conflict with direct API - HA integration says "Devices must NOT be connected to U-Tec Air". May need to choose one or the other.
- Legacy REST API also exists at `api.u-tec.com/device/...` (documented in GitHub: u-tec-com/api apiary.apib)

### Legacy REST API (Alternative)
GitHub blueprint: https://github.com/u-tec-com/api/blob/master/apiary.apib
- `GET /device/locks` - list locks
- `GET /device/lock/users` - list users on a lock
- `POST /device/lock/users` - add user
- `DELETE /device/lock/user/{id}` - delete user
- `PUT /device/lock/user-shifts` - add time-limited shifts
- Uses same OAuth2 tokens

## Credentials
Stored in `.env` (git-ignored):
- `XTHINGS_CLIENT_ID` - from Developer Console (pending)
- `XTHINGS_CLIENT_SECRET` - from Developer Console (pending)
- `XTHINGS_API_URL=https://api.u-tec.com/action`
- `XTHINGS_OAUTH_URL=https://oauth.u-tec.com`
- `ULTRALOQ_EMAIL` - account login
- `ULTRALOQ_PASSWORD` - account password

## Postman Collection
Full collection saved at: `docs/postman-collection.json` (66KB, 10 endpoints)

## References
- Official API docs (Postman): https://doc.api.u-tec.com/
- Legacy API blueprint: https://github.com/u-tec-com/api/blob/master/apiary.apib
- HA integration (working OAuth example): https://github.com/LF2b2w/Uhome-HA
- HA integration (alt): https://github.com/jellojank/uhome
- Developer portal: https://developer.xthings.com/hc/en-us

## Tech Stack
- Node.js (v24 available on system)
- Project directory: `/home/bc/guestkey/`

## Project Status
- **Code:** Complete and tested (DB, API client, iCal poller, WhatsApp notifier, scheduler, CLI)
- **Blocker:** Waiting for U-tec Developer Account approval to get valid OAuth credentials
- **iCal feed:** Live and parsing 4 reservations correctly
- **Next step:** Once credentials arrive, run `guestkey setup` to complete OAuth + lock discovery + WhatsApp QR
