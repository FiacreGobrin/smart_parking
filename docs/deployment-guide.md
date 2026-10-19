# Deployment guide

Target: **Neon** (PostgreSQL) + **Render** (API) + **Vercel** (frontend). Railway/Fly work the same way for the API. Nothing here has been deployed from this repository yet; treat the post-deploy checks as mandatory before calling a deployment successful.

## 1. Database (Neon)

1. Create a project; note the pooled and direct connection strings (see README).
2. From a trusted machine: `cd backend && DIRECT_DATABASE_URL=... DATABASE_URL=... npx prisma migrate deploy`.
3. Create the first administrator: `NODE_ENV=production SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run db:seed`.
4. Enable Neon backups/point-in-time restore (see section 5).

## 2. API (Render)

Use `render.yaml` (Blueprint) or create a Web Service manually with root directory `backend`:

| Setting | Value |
|---|---|
| Build | `npm ci && npx prisma generate` |
| Pre-deploy | `npx prisma migrate deploy` |
| Start | `node src/server.js` |
| Health check | `/api/v1/health` |

Environment variables (secrets in the dashboard only):

```
NODE_ENV=production
DATABASE_URL=<neon pooled>        DIRECT_DATABASE_URL=<neon direct>
JWT_SECRET=<48+ random bytes>     FRONTEND_URL=https://<your-vercel-domain>
ANPR_MODE=simulation|http         PAYMENT_MODE=simulation|live
UPLOAD_DIR=/var/data/uploads      (persistent disk mounted at /var/data)
```

Notes:
- **Host the API in the same region as Neon** (this project's Neon is AWS us-east-2, so Render *Ohio*). Every query is a network round trip: ~350 ms from Rwanda, ~2 ms in the same region. Alternatively create the Neon project in Frankfurt (closest to East Africa) and host the API there.
- Do **not** add `pgbouncer=true` to `DATABASE_URL`: with Neon's pooler it made every Prisma query ~5x slower. Use `?sslmode=require&connect_timeout=30`.
- The first OCR scan downloads the English language data (needs internet, cached in `.tessdata`); keep that folder on a persistent disk or accept a one-time download after each deploy.
- The API sits behind a proxy: `trust proxy` is set, cookies are `Secure` + `SameSite=None` in production so the Vercel origin can use the refresh cookie. Browsers require HTTPS on both sides.
- `FRONTEND_URL` accepts a comma-separated list; CORS allows only those origins.
- Free tiers sleep when idle; use a paid plan for gates/cameras that need immediate responses.
- Production refuses the dev webhook-secret fallback: set `MOMO_WEBHOOK_SECRET` before enabling real mobile money.
- Set `PAYMENT_MODE=live` and `ANPR_MODE=http` only after the adapters are configured and tested; `simulation` in production is labelled in the UI but moves no money and reads no images.

## 3. Frontend (Vercel)

Project root `frontend`, framework Vite, build `npm run build`, output `dist`. Environment: `VITE_API_BASE_URL=https://<api-host>/api/v1` (and `VITE_SOCKET_URL=https://<api-host>`). `vercel.json` provides the SPA rewrite and basic security headers.

## 4. Post-deployment checks (do all of them)

```bash
curl -s https://<api>/api/v1/health                       # {"status":"ok","database":"up"}
curl -s -o /dev/null -w "%{http_code}" https://<api>/api/v1/users   # 401 without a token
```

1. Open the frontend, sign in with the administrator, confirm the dashboard loads (no CORS errors in the browser console).
2. Reload the page: you stay signed in (refresh cookie works cross-site).
3. Create a facility, space, gate and tariff; register an entry and exit with a cash payment; open the receipt.
4. Confirm the live socket: open two tabs, make an entry in one, watch the other update.
5. Check the audit log shows your actions.
6. Verify `GET /api/v1/docs` is not publicly exposed unless intended.

## 5. Backups, monitoring, incident recovery

- **Backups**: enable Neon point-in-time restore (retention per plan) and take a logical dump weekly: `pg_dump "$DIRECT_DATABASE_URL" -Fc -f smartparking-$(date +%F).dump`. Test a restore into a scratch Neon branch quarterly.
- **Monitoring**: point an uptime monitor at `/api/v1/health` (returns 503 when the database is unreachable). Logs are structured JSON with a `requestId` that also appears in every error response, so a user report can be traced.
- **Incident: bad migration or data corruption**: stop writes (scale the API to 0), create a Neon branch from a timestamp before the incident, verify, then repoint `DATABASE_URL`/`DIRECT_DATABASE_URL` or restore the branch; redeploy.
- **Incident: leaked secret**: rotate `JWT_SECRET` (signs out everyone), database password (Neon console), provider keys and webhook secret; review `AuditLog` for the exposure window.
- **Incident: gate/camera outage**: gates fail closed (no automatic admission). Attendants use the desk entry/exit panels; devices raise `DEVICE_OFFLINE` notifications.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser shows CORS error | `FRONTEND_URL` does not exactly match the frontend origin (scheme + host, no trailing slash) |
| Signed out on every reload in production | Cookie blocked: API not on HTTPS, or `NODE_ENV` not `production` (cookie needs `SameSite=None; Secure`) |
| `P1001 Can't reach database` | Wrong URL, missing `sslmode=require`, or Neon compute suspended and still waking (retry) |
| Migrations hang/fail on Neon | `DIRECT_DATABASE_URL` points to the pooled host; use the direct one |
| `extension btree_gist` error | Run the migration as the database owner role |
| Images disappear after deploy | `UPLOAD_DIR` is on an ephemeral disk; mount a persistent volume |
| 429 responses | Rate limits (login 10 failures/15 min, API 600/min per IP) |
