# API documentation

Interactive Swagger UI: `GET /api/v1/docs` (OpenAPI JSON at `/api/v1/openapi.json`). Enabled outside production; set `ENABLE_API_DOCS=true` to expose it in production (consider protecting it).

Base URL: `/api/v1`. All routes except those marked *public* need `Authorization: Bearer <accessToken>`.

## Conventions

Success: `{ "success": true, "data": ..., "meta": { page, limit, total, totalPages } }`

Error: `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [{ "field", "message" }], "requestId": "..." } }`

| Status | Meaning |
|---|---|
| 400 | Validation failed (`details` lists fields) |
| 401 | Missing/expired token, bad credentials |
| 402 | Exit refused: balance due (`error.details.balanceDue`) |
| 403 | Not permitted, or access denied by a rule (`ACCESS_DENIED_<REASON>`) |
| 404 / 409 | Not found / conflict (duplicate plate, overlapping reservation, space taken) |
| 422 | Business rule (nothing due, amount mismatch, no tariff) |
| 423 | Account locked after 5 failed sign-ins (15 min) |
| 429 | Rate limited |
| 501 | Provider/method not configured (e.g. card payments) |

Lists accept `page`, `limit` (max 100), `sortBy`, `order=asc|desc`, `search`, and resource filters. Most list endpoints with `format=csv` export (needs the `export` permission).

## Authentication

- `POST /auth/register` (public) `{ name, phone, nationalId }` creates a **Pending** account (national ID = 16 digits, phone = Rwandan mobile). It cannot sign in until approved.
- `POST /auth/login` (public) `{ username, password, code? }` (an e-mail is accepted as `email`) returns `{ accessToken, user }` and sets the `sp_refresh` httpOnly cookie. First sign-in after approval needs the 6-digit `code`: without it the API answers `401 ACTIVATION_CODE_REQUIRED`. Blocked/pending accounts get `403 ACCOUNT_BLOCKED` / `ACCOUNT_PENDING` (only after a correct password). Access tokens last 15 minutes.
- `POST /auth/refresh` (public, cookie) rotates the refresh token. Re-using an old refresh token revokes the whole session family.
- `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/profile`, `POST /auth/change-password`, `GET /auth/login-history`
- `POST /auth/forgot-password { username }`, `POST /auth/reset-password` (public; identical response for unknown users; single-use token valid 1 h)

## Users

`GET /users` (`status=PENDING|ACTIVE|BLOCKED`, `search` by name/username/phone/ID), `GET /users/stats` (counts for the filter pills), `POST /users/generate {name, phone}` (preview of code, username, password; stores nothing), `POST /users` (create; returns the credentials once), `PATCH /users/:id`, `POST /users/:id/approve`, `POST /users/:id/credentials` (re-issue for an existing user), `POST /users/:id/block`, `POST /users/:id/unblock`, `DELETE /users/:id` (archive). Credentials are returned only in that one response; the SMS log stores the message with the password masked.

## Prices

`GET/POST/PATCH/DELETE /rates` with `{ service: PARKING|GARAGE|CAR_WASH, vehicleType, unit: HOUR|DAY|WEEK|MONTH|VISIT, startPrice (>=100), increment, cap, validFrom, isActive }`. Parking is billed per hour, garage per day/week/month, car wash per visit. `POST /rates/preview { unit, startPrice, increment, cap, minutes }` returns the fee breakdown without storing anything.

Fee = start price + (units started - 1) x increase, never above the cap. For hourly prices the cap is per 24 hours. Example: 3 h 15 min = 4 hours started = 100 + 3 x 100 = 400 RWF.

## Parking flow

```
POST /parking/entry        { plate, facilityId?, gateId?, vehicleType?, spaceId?, notes?, service?: PARKING|GARAGE|CAR_WASH, billingUnit? }
GET  /parking/exit-preview ?plate= | ?sessionId=            -> fee breakdown, balanceDue
POST /payments             { sessionId, method: CASH|MOBILE_MONEY|BANK, provider?: mtn-momo|airtel-money|equity-bank, payerPhone?, amount?, idempotencyKey? }
POST /parking/exit         { sessionId | plate, gateId?, exempt?, exemptReason?, discountPercent? }
```

- Entry denial codes: `NO_PLATE`, `GATE_NOT_ONLINE`, `RESTRICTED_VEHICLE`, `ALREADY_INSIDE`, `FACILITY_FULL`, `UNREGISTERED_VEHICLE`, `LOW_CONFIDENCE`, `FACILITY_INACTIVE`. Unverifiable access is denied by default.
- `Idempotency-Key` header (or `idempotencyKey`) makes payment creation safe to retry: a repeat returns the original payment with `meta.replay=true`.
- Exemptions and discounts require `sessions.exempt` and a reason; both are audited.
- A payment made within 15 minutes of exit freezes the fee so the driver is not re-charged.

## Payments and webhooks

`POST /payments/webhooks/:provider` (public, signature-authenticated). Body is JSON; header `X-Signature` = hex HMAC-SHA256 of the **raw body** with `MOMO_WEBHOOK_SECRET`.

```json
{ "eventId": "evt_123", "providerReference": "SIM-ABC", "status": "SUCCESS", "amount": "2400.00" }
```

Provider keys: `mtn-momo`, `airtel-money`, `equity-bank`. Payment references look like `MM-2026-001245` (prefix by provider, `CS` for cash). `GET /sms-messages` lists the SMS outbox.

Each `eventId` is processed once; the amount must equal the payment's amount; only then is the payment marked `SUCCESS` and the receipt issued. Development only: `POST /payments/:id/simulate-callback { status }` sends a correctly signed callback (disabled when `PAYMENT_MODE=live`).

Other: `GET /payments`, `GET /payments/:id`, `GET /payments/:id/receipt`, `POST /payments/:id/refund { reason }` (finance), `GET /payments/reconciliation/summary?date=`, `POST /payments/reconciliation/close { date }`.

## Devices and ANPR

- `POST /gates/:id/commands { command: OPEN|CLOSE|LOCK|UNLOCK, reason? }` returns `{ acknowledged, simulated, outcome }`. A gate that is not ONLINE is never sent an OPEN command.
- `POST /gates/:id/ping`, `GET /gates/:id/events`, `GET /gate-events`
- `POST /anpr/scan` (multipart `image`, `facilityId?`): phone-camera capture used by the Operations screen; never acts automatically.
- `POST /anpr/recognize` (multipart: `cameraId`, `image`, plus in simulation `simulatedPlate`, `simulatedConfidence`; `autoProcess=true` acts on confident reads at the camera's gate)
- `GET /anpr/events`, `POST /anpr/events/:id/confirm { plate?, process? }`, `GET /anpr/status`

## Everything else

Users, facilities, zones, spaces (`/spaces/bulk`), vehicles (`/vehicles/lookup/:plate`, `/vehicles/:id/history`, `/vehicles/:id/image`), cameras, gates, rates, reservations (`/cancel`, `/check-in`), permits (`/renew`, `/pay`), reports (`/reports`, `/reports/:type`), notifications, audit logs, settings, dashboard. The Swagger UI lists each route with the permission it requires.

## Real-time events (Socket.IO)

Connect with `auth: { token: <accessToken> }`. Users are placed in their facility's room (or all). Events: `occupancy:update`, `session:entry`, `session:exit`, `payment:update`, `recognition:new`, `gate:update`, `notification:new`. The UI also polls (20-60 s) so it works if the socket is blocked.
