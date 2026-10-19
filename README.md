# Smart Parking Management System

Full-stack parking operations platform for Rwanda: live occupancy, entry/exit desks, plate recognition (integration-ready), gates, tariffs, cash and mobile-money payments, reservations and permits, reports, audit trail.

| Layer | Stack |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4, React Router, React Hook Form + Zod, Recharts, Lucide, Socket.IO client |
| Backend | Node.js, Express 5, Prisma 6, Zod, JWT (access + rotating refresh), bcrypt, Socket.IO, Multer, Helmet |
| Database | PostgreSQL (Neon in production) |

> **Read this first: what is real and what is simulated**
>
> | Area | Status |
> |---|---|
> | SMS | Real delivery is built in through **Africa's Talking** (`SMS_MODE=africastalking`). It stays in recording-only mode until you add `AT_USERNAME` and `AT_API_KEY` from your own account; until then credentials are shown on screen and logged (password masked). |
> | Plate recognition | **Built-in OCR** (`ANPR_MODE=ocr`, Tesseract) reads the letters and digits from the photo and keeps the photo and the text in Neon. It works best on a sharp, close, frontal photo of one plate; every read below 85% confidence asks the operator to confirm. It is not a full ANPR system (no detection in wide scenes, glare or night). For that, use `ANPR_MODE=http` with a separate engine ([docs/integration-guide.md](docs/integration-guide.md)). |
> | Mobile money / bank | MTN MoMo, Airtel Money and Equity Bank run as **simulations** (`PAYMENT_MODE=simulation`): a payment becomes successful only through a signed provider callback, which the UI can fire in development. A generic live adapter must be adapted to each provider's real API. |
> | Gate controllers | `SIMULATION` controllers acknowledge commands without moving anything. `HTTP` controllers are supported; a barrier counts as opened only when the controller acknowledges. |
> | Neon | Connected and migrated for this project. Keep credentials in `backend/.env` only. |

## Screens (as designed)

Sidebar: **Dashboard, Users (CRUD), Price / Cost (CRUD), Operations, Business Process, Statistics, Finance, System Telephone, Settings.**

- **Users (CRUD)**: filter pills All / Pending / Active / Blocked with counts; table (full name, phone, national ID, username, status) with Approve / Edit / Block / Unblock / Delete; side form that generates a 6-digit code, a username (`initial + surname + first 4 phone digits`, e.g. `juwase_0788`) and a password, then saves the user.
- **Price / Cost (CRUD)**: services Parking, Garage, Car Wash; billing unit hour/day/week/month/visit; **price = start price + (units started - 1) x increase, never above the cap** (parking cap is per day); minimum start price 100 RWF; effective-from date; live fee preview that uses the real pricing engine.
- **Operations** (phone-friendly): Scan Plate (phone camera or manual) -> new vehicle gets registered, a vehicle inside goes to Payment (MTN MoMo, Airtel Money, Equity Bank, or cash) -> Receipt with reference such as `MM-2026-001245`; "Done" releases the vehicle.
- **Business Process**: the six steps (sign-up, approval, scan, fee, payment, receipt) with live counts.
- **Statistics** (charts, CSV, print), **Finance** (payments, refunds, daily reconciliation), **System Telephone** (merchant numbers, SMS sender, SMS log), **Settings** (facilities, spaces, gates, cameras, audit log, notifications, system options).

Features that exist only in the API (vehicle registry, reservations, permits, ANPR console endpoints) have no screen, because they are not in the design. They are documented in the Swagger UI.

## Quick start (local)

Requirements: Node.js 20+.

```bash
# 1. Backend
cd backend
cp .env.example .env            # then fill DATABASE_URL, DIRECT_DATABASE_URL, JWT_SECRET (see below)
npm install
npx prisma migrate deploy       # creates the schema (+ constraints, triggers)
npm run db:seed                 # demo data (skipped automatically in production)
npm run dev                     # http://localhost:5000  (docs: /api/v1/docs)

# 2. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                     # http://localhost:5173
```

**No database yet?** For local development only, `npm run db:local` in `backend/` starts a throwaway embedded PostgreSQL on port 54329 (data in `backend/.localdb`). Use `DATABASE_URL=postgresql://postgres:postgres@localhost:54329/smartparking`.

### Demo accounts (development seed only)

Sign in with a **username** (e-mail still works for the seeded staff). All use password `Parking#2026` (override with `SEED_DEMO_PASSWORD`). **Never seed demo data in production.**

| Role | Username |
|---|---|
| Admin (super administrator) | `admin` |
| Parking admin (City Centre) | `auwase_0788` |
| Attendant (City Centre) | `jhabimana_0722` |
| Finance officer | `eniyonzima_0781` |
| Viewer | `gingabire_0735` |
| User (field user) | `amukamana_0722` |

The seed also contains two pending sign-ups and one blocked user so the Users screen has content.

New accounts: a person signs up at `/signup` (name, phone, national ID) and stays **Pending**; an administrator approves it, which generates and "sends" the code, username and password. At first sign-in the user enters the 6-digit code once.

## Connecting Neon PostgreSQL

1. Create a Neon project and database.
2. In the Neon console copy **two** connection strings:
   - **Pooled** (host contains `-pooler`) into `DATABASE_URL`, used by the running API.
   - **Direct** (no `-pooler`) into `DIRECT_DATABASE_URL`, used by `prisma migrate`.
3. Keep `?sslmode=require` on both. Optionally append `&connect_timeout=15` for cold starts.
4. Apply the schema: `cd backend && npx prisma migrate deploy`.
5. First administrator in production (no demo data): set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_USERNAME` (optional) and `SEED_ADMIN_PASSWORD` (min. 10 chars, letter + digit) and run `SEED_DEMO=false npm run db:seed`. Then add prices under Price / Cost and a facility with spaces under Settings.

The migrations include things Prisma cannot model, so always use `migrate deploy`, never `db push`:
partial unique indexes (one ACTIVE session per plate and per space), a GiST exclusion constraint (no overlapping reservations on a space), and a trigger that makes `AuditLog` append-only. The `btree_gist` extension is created by the migration (allowed on Neon).

Secrets: only the backend reads `DATABASE_URL`, `JWT_SECRET` and provider keys. The frontend `.env` holds public values only (`VITE_*`). `.env` files are git-ignored.

## Project structure

```
backend/
  prisma/            schema.prisma, migrations/ (init + constraints), seed.js
  src/
    config/          env validation, prisma client, permissions, logger
    routes/          thin HTTP layer (+ crud.js factory, openapi.js)
    services/        business rules: parking, pricing, gateDecision, payments, anpr, reports...
    integrations/    anpr/, payments/, gate-controllers/  (adapters, swap without touching services)
    middleware/      auth, validation, rate limits, uploads, error handler
    sockets/         Socket.IO server + room scoping
  tests/             unit/ (pure logic) and integration/ (API + database)
frontend/src/        components/ui, components/charts, layouts, pages, features, routes, context, services, utils
docs/                api, database, deployment, integration, testing
render.yaml          Render blueprint for the API
```

## Roles and permissions

Permissions live in `backend/src/config/permissions.js` and are enforced by `requirePermission(...)` on every protected route, with facility scoping for facility-bound users. Hiding a button in the UI is only a convenience.

| Role | Highlights |
|---|---|
| Admin (Super Administrator) | Everything: users, facilities, prices, settings, telephone, audit |
| Parking Administrator | Own facility: users/attendants/viewers, spaces, gates, cameras, operations, reports |
| Attendant / User | Operations: scan plates, register entries, take payments, receipts |
| Finance Officer | Payments, refunds, reconciliation, financial statistics and exports; no operational control |
| Viewer | Read-only dashboard, statistics (non-financial) and settings views; no personal or money data |

## Feature map

Public sign-up with admin approval, blocking and generated credentials (SMS-ready) · Username sign-in with one-time activation code, lockout and rotating refresh tokens · Services priced by start price + increase with caps · Parking, garage and car-wash sessions with transactional space allocation · MTN MoMo / Airtel Money / Equity Bank / cash payments, idempotent and webhook-verified, refunds and receipts · Dashboard, statistics, daily reconciliation · Notifications, audit log (append-only), system settings · Real-time updates over Socket.IO with polling fallback.

## Testing

```bash
cd backend
npm run db:local                 # in another terminal, if you use the embedded database
npm test                         # unit + integration (uses the smartparking_test database)
npm run test:unit                # no database needed
cd ../frontend && npm run build  # production build verification
```

Integration tests refuse to run unless the database name contains `test` (they truncate tables). Set `TEST_DATABASE_URL` to use another server. See [docs/testing-plan.md](docs/testing-plan.md) for the end-to-end plan.

## Deployment (summary)

Frontend on Vercel (`frontend/`, set `VITE_API_BASE_URL`), API on Render/Railway (`render.yaml`), database on Neon. Full steps, CORS/cookie settings, backups and incident recovery: [docs/deployment-guide.md](docs/deployment-guide.md). A deployment is only "done" after you run the post-deploy checks listed there against the live URLs.

## Known limitations / next steps

- SMS delivery and password-reset messages: no gateway is wired. Generated credentials are shown on screen and logged (masked) in System Telephone. Implement `integrations/sms/index.js` for your gateway, then set `SMS_MODE=http`.
- One open session per plate: a vehicle cannot be in a car-wash visit and parked at the same time.
- Provider-specific adapters for MTN MoMo, Airtel Money and Equity Bank still need to be built against each provider's sandbox; card payments return 501.
- A real ANPR engine (Python + OpenCV/YOLO/EasyOCR) and physical gate controllers are integrations to be connected and field-tested.
- Uploaded images are stored on local disk (`UPLOAD_DIR`); on hosts with ephemeral disks mount a volume or move to object storage.
