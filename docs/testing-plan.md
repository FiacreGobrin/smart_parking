# Testing plan

## Automated (run in CI)

| Suite | Location | Needs DB | Covers |
|---|---|---|---|
| Unit | `backend/tests/unit` | no | plate normalization/formats, fee calculation (start price + increase per unit, daily caps, day/week/month/visit units, discounts, tax, decimal exactness), phone/ID/username/code/password generation, tariff selection, gate authorization decisions (deny by default), role permissions, webhook signatures, CSV injection safety, Kigali day boundary |
| API integration | `backend/tests/integration` | yes (`*_test` DB) | auth, lockout, activation code, sign-up/approval/block, generated credentials and masked SMS log, refresh rotation/reuse, password reset, RBAC and facility isolation, validation/error format, vehicle registry, entry/space allocation, concurrency (same plate, same space), exit blocked until paid, idempotent payments, MTN MoMo / Airtel Money / Equity Bank pending -> signed callback, references, replay/mismatch handling, refunds, exemptions, reservations (API + DB constraint), permits, gate failures, ANPR (confidence, duplicates, correction, auto-process, upload validation), reports/CSV/audit, append-only audit trigger, user management limits, settings audit |
| Frontend build | `npm run build` in `frontend` | no | compiles all pages |

CI example:

```yaml
- run: cd backend && npm ci && npx prisma migrate deploy && npm test
  env: { TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/smartparking_test }
- run: cd frontend && npm ci && npm run build
```

Migration + seed verification: on an empty database run `npx prisma migrate deploy && node prisma/seed.js`; then `npx prisma migrate status` must report no pending migrations, and re-running the seed must be a no-op.

## End-to-end plan (manual or Playwright)

Run against a seeded environment with `ANPR_MODE=simulation`, `PAYMENT_MODE=simulation`, `SMS_MODE=simulation`.

1. **Sign-up and approval**: open `/signup`, submit name, phone and a 16-digit national ID (try an invalid ID and a duplicate phone: rejected). Sign in as admin, open Users: the person is Pending (counts update). Approve (choose a facility first if several exist): code, username and password appear and a "not delivered" notice shows. Sign in as that user: the code is asked once; blocked users cannot sign in and are signed out at once.
2. **Users form**: Add user, Generate (username like `juwase_0788`), Save; edit; Block / Unblock; Delete; try deleting yourself (refused).
3. **Prices**: add Parking/Car/hour 100 + 100, cap 2000; the preview shows `100 + 3 x 100 = 400 RWF` for 3 h 15 m; a start price of 50 is rejected; add Garage per month and Car Wash per visit.
4. **Operations - entry**: Write manually, enter a new plate, Confirm: the new-vehicle step appears; choose service, register; a space is assigned (Settings > Spaces shows it occupied).
5. **Operations - payment**: scan the same plate after a while: the amount follows the price rule. Tap Pay with an empty phone (validation). Pay with MTN MoMo: status stays pending and exit is blocked; use Simulate decline (failed), retry, Simulate approval: Receipt shows Plate, Service, Method, Reference `MM-<year>-NNNNNN`, Date, Amount. Done releases the vehicle. Repeat with Airtel Money, Equity Bank and Cash.
6. **Camera**: on a phone over HTTPS, Phone camera shows the preview; Take photo uploads it. In simulation mode the app says it cannot read photos and asks for manual entry.
7. **Finance**: as finance officer open Finance: refund a payment (reason required), reconcile the day, export CSV; no access to Users or Operations.
8. **Statistics / Business Process / System Telephone / Settings**: charts and counts load; CSV export and print work; telephone numbers save (admin only) and the SMS log shows masked passwords; Settings tabs match the role.
9. **Restrictions**: viewer sees no money figures and no Users/Prices edit controls; a parking admin only sees their facility's people.
10. **Resilience and accessibility**: stop the API: pages show an error state with *Try again*; block WebSockets: dashboards still refresh via polling; 390 px width has no horizontal page scroll; dark theme; keyboard-only navigation.
