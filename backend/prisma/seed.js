// Seed script.
//   Production: only creates the first super administrator when SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set.
//   Development/demo (default outside production, or SEED_DEMO=true): adds realistic demo data.
// All demo payments/events are flagged as simulated; nothing here represents real money or hardware.
import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const isProd = process.env.NODE_ENV === 'production';
const demo = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : !isProd;
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Parking#2026';

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];
const hash = (pw) => bcrypt.hash(pw, 10);
const hex = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || (demo ? 'admin@smartparking.rw' : '')).toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || (demo ? DEMO_PASSWORD : '');
  if (!email || !password) {
    console.log('No SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD set: skipping super administrator.');
    return;
  }
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, username: (process.env.SEED_ADMIN_USERNAME || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_]/g, '_'), name: 'System Administrator', role: 'SUPER_ADMIN', passwordHash: await hash(password) },
  });
  console.log(`Super administrator ready: ${email}`);
}

function plateFor(i) {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  return `R${letters[i % letters.length]}${letters[(i * 7 + 3) % letters.length]}${String(100 + ((i * 37) % 900))}${letters[(i * 5 + 1) % letters.length]}`;
}

async function seedDemo() {
  if ((await prisma.parkingFacility.count()) > 0) {
    console.log('Facilities already exist: skipping demo data.');
    return;
  }
  const pw = await hash(DEMO_PASSWORD);

  const kcc = await prisma.parkingFacility.create({ data: { code: 'KCC', name: 'Kigali City Centre Parking', address: 'KN 4 Ave, Nyarugenge', city: 'Kigali', lowAvailabilityThreshold: 10 } });
  const kim = await prisma.parkingFacility.create({ data: { code: 'KIM', name: 'Kimironko Market Parking', address: 'KG 11 Ave, Gasabo', city: 'Kigali', lowAvailabilityThreshold: 15 } });

  const mkSpaces = async (facilityId, zoneName, floor, prefix, count, type = 'STANDARD') => {
    const zone = await prisma.parkingZone.create({ data: { facilityId, name: zoneName, floor } });
    await prisma.parkingSpace.createMany({
      data: Array.from({ length: count }, (_, i) => ({ facilityId, zoneId: zone.id, code: `${prefix}${String(i + 1).padStart(2, '0')}`, type })),
    });
    return zone;
  };
  await mkSpaces(kcc.id, 'Ground Floor', 'G', 'A', 30);
  await mkSpaces(kcc.id, 'Level 1', 'L1', 'B', 20);
  await mkSpaces(kcc.id, 'Motorcycle Bay', 'G', 'M', 10, 'MOTORCYCLE');
  await mkSpaces(kcc.id, 'Accessible', 'G', 'H', 3, 'ACCESSIBLE');
  await mkSpaces(kcc.id, 'EV Charging', 'G', 'E', 4, 'EV');
  await mkSpaces(kcc.id, 'VIP', 'L1', 'V', 3, 'VIP');
  await mkSpaces(kim.id, 'Market Lot', 'G', 'K', 25);
  await mkSpaces(kim.id, 'Motorcycle Bay', 'G', 'KM', 10, 'MOTORCYCLE');
  await prisma.parkingSpace.update({ where: { facilityId_code: { facilityId: kcc.id, code: 'B20' } }, data: { status: 'OUT_OF_SERVICE', notes: 'Flooded bay, awaiting repair' } });

  // Staff and users. Username pattern: initial + last name + first 4 digits of the phone (juwase_0788).
  let seq = 0;
  const nid = () => `1199${String(80000000000 + (seq++) * 7919).padStart(12, '0')}`;
  const mk = (username, name, role, facilityId, phone, extra = {}) => prisma.user.create({
    data: { username, name, role, facilityId, phone: `+250${phone}`, nationalId: nid(), passwordHash: pw, status: 'ACTIVE', ...extra },
  });
  await prisma.user.updateMany({ where: { username: 'admin' }, data: {} });
  const kccAdmin = await mk('auwase_0788', 'Aline Uwase', 'PARKING_ADMIN', kcc.id, '788111222', { email: 'manager.kcc@smartparking.rw' });
  const attendant = await mk('jhabimana_0722', 'Jean Claude Habimana', 'ATTENDANT', kcc.id, '722456789', { email: 'attendant.kcc@smartparking.rw' });
  await mk('dmukamana_0733', 'Diane Mukamana', 'ATTENDANT', kim.id, '733111222', { email: 'attendant.kim@smartparking.rw' });
  const finance = await mk('eniyonzima_0781', 'Eric Niyonzima', 'FINANCE_OFFICER', null, '781222333', { email: 'finance@smartparking.rw' });
  await mk('gingabire_0735', 'Grace Ingabire', 'VIEWER', null, '735666123', { email: 'viewer@smartparking.rw' });
  await mk('amukamana_0722', 'Aline Mukamana', 'USER', kcc.id, '722456790');
  await mk('ehabimana_0733', 'Eric Habimana', 'USER', kcc.id, '733111223');
  await mk('cingabire_0788', 'Claire Ingabire', 'USER', kim.id, '788999000');
  await mk('pniyonzima_0781', 'Patrick Niyonzima', 'USER', kim.id, '781222334', { status: 'BLOCKED' });
  for (const [n, ph] of [['Jean Uwase', '788123456'], ['Diane Uwimana', '726777888']]) {
    // Sign-ups waiting for approval: no usable credentials until an administrator approves them.
    await prisma.user.create({ data: { username: `pending_${seq}`, name: n, role: 'USER', status: 'PENDING', phone: `+250${ph}`, nationalId: nid(), passwordHash: pw } });
  }

  // Prices (RWF). Parking: start + (hours started - 1) x increase, never above the daily cap.
  const eff = new Date('2026-10-16T00:00:00Z');
  await prisma.parkingRate.createMany({
    data: [
      { name: 'Parking - Car - hour', service: 'PARKING', vehicleType: 'CAR', unit: 'HOUR', startPrice: 100, increment: 100, cap: 2000, validFrom: eff },
      { name: 'Parking - Motorbike - hour', service: 'PARKING', vehicleType: 'MOTORCYCLE', unit: 'HOUR', startPrice: 100, increment: 50, cap: 1000, validFrom: eff },
      { name: 'Parking - Bus - hour', service: 'PARKING', vehicleType: 'BUS', unit: 'HOUR', startPrice: 500, increment: 500, cap: 8000, validFrom: eff },
      { name: 'Parking - Truck - hour', service: 'PARKING', vehicleType: 'TRUCK', unit: 'HOUR', startPrice: 500, increment: 500, cap: 8000, validFrom: eff },
      { name: 'Garage - Car - day', service: 'GARAGE', vehicleType: 'CAR', unit: 'DAY', startPrice: 1500, increment: 0, cap: 1500, validFrom: eff },
      { name: 'Garage - Car - week', service: 'GARAGE', vehicleType: 'CAR', unit: 'WEEK', startPrice: 8000, increment: 0, cap: 8000, validFrom: eff },
      { name: 'Garage - Car - month', service: 'GARAGE', vehicleType: 'CAR', unit: 'MONTH', startPrice: 25000, increment: 0, cap: 25000, validFrom: eff },
      { name: 'Garage - Motorbike - month', service: 'GARAGE', vehicleType: 'MOTORCYCLE', unit: 'MONTH', startPrice: 10000, increment: 0, cap: 10000, validFrom: eff },
      { name: 'Car wash - Car - visit', service: 'CAR_WASH', vehicleType: 'CAR', unit: 'VISIT', startPrice: 2000, increment: 0, cap: 4000, validFrom: eff },
      { name: 'Car wash - Motorbike - visit', service: 'CAR_WASH', vehicleType: 'MOTORCYCLE', unit: 'VISIT', startPrice: 1000, increment: 0, cap: 2000, validFrom: new Date(Date.now() + 14 * 86400000) },
    ],
  });

  // Gates and cameras (SIMULATION controllers: no hardware is attached)
  const mkGate = (facilityId, name, direction) => prisma.gate.create({ data: { facilityId, name, direction, controllerType: 'SIMULATION', lastHeartbeatAt: new Date() } });
  const kccIn = await mkGate(kcc.id, 'KCC Entry Gate 1', 'ENTRY');
  const kccOut = await mkGate(kcc.id, 'KCC Exit Gate 1', 'EXIT');
  const kimIn = await mkGate(kim.id, 'Kimironko Entry', 'ENTRY');
  const kimOut = await mkGate(kim.id, 'Kimironko Exit', 'EXIT');
  for (const [g, f, n] of [[kccIn, kcc, 'KCC Entry Cam'], [kccOut, kcc, 'KCC Exit Cam'], [kimIn, kim, 'Kimironko Entry Cam'], [kimOut, kim, 'Kimironko Exit Cam']]) {
    await prisma.camera.create({ data: { facilityId: f.id, gateId: g.id, name: n, isSimulated: true, lastSeenAt: new Date() } });
  }
  await prisma.camera.create({ data: { facilityId: kcc.id, name: 'KCC Level 1 Cam', status: 'OFFLINE', isSimulated: true } });

  // Vehicles
  const owners = ['Patrick Nkurunziza', 'Marie Claire Uwimana', 'Olivier Mugisha', 'Solange Iradukunda', 'Emmanuel Ndayisaba', 'Chantal Mukeshimana', 'Jean Bosco Habyarimana', 'Vestine Nyirahabimana'];
  const makes = [['Toyota', 'RAV4'], ['Toyota', 'Corolla'], ['Suzuki', 'Swift'], ['Hyundai', 'Tucson'], ['Nissan', 'X-Trail'], ['Honda', 'CR-V'], ['Mitsubishi', 'L200'], ['Kia', 'Rio']];
  const colors = ['White', 'Black', 'Silver', 'Blue', 'Red', 'Grey'];
  const vehicles = [];
  for (let i = 0; i < 30; i++) {
    const [make, model] = makes[i % makes.length];
    const plate = plateFor(i);
    const isMoto = i % 7 === 6;
    const v = await prisma.vehicle.create({
      data: {
        plate, plateDisplay: `${plate.slice(0, 3)} ${plate.slice(3, 6)} ${plate.slice(6)}`,
        type: isMoto ? 'MOTORCYCLE' : 'CAR', make: isMoto ? 'TVS' : make, model: isMoto ? 'Apache' : model, color: pick(colors),
        status: i === 3 ? 'RESTRICTED' : i % 9 === 0 ? 'AUTHORIZED' : 'REGISTERED', restrictionReason: i === 3 ? 'Unpaid fees from previous visits' : null,
        owner: i < owners.length ? { create: { name: owners[i], phone: `+25078${rnd(1000000, 9999999)}` } } : undefined,
      },
    });
    vehicles.push(v);
  }

  // Historical completed sessions with payments over the last 14 days (powers the charts)
  const facilitiesInfo = [{ f: kcc, gateIn: kccIn, gateOut: kccOut, rate: 800 }, { f: kim, gateIn: kimIn, gateOut: kimOut, rate: 500 }];
  const spacesByFacility = Object.fromEntries(await Promise.all(facilitiesInfo.map(async ({ f }) => [f.id, await prisma.parkingSpace.findMany({ where: { facilityId: f.id, status: 'AVAILABLE' }, take: 40 })])));
  for (let d = 14; d >= 1; d--) {
    for (const info of facilitiesInfo) {
      const n = rnd(info.f.id === kcc.id ? 10 : 6, info.f.id === kcc.id ? 22 : 14);
      for (let k = 0; k < n; k++) {
        const v = pick(vehicles);
        const entryAt = new Date(Date.now() - d * 86400000 + rnd(6, 20) * 3600000 + rnd(0, 59) * 60000);
        const minutes = rnd(20, 420);
        const exitAt = new Date(entryAt.getTime() + minutes * 60000);
        const blocks = Math.max(1, Math.ceil(minutes / 60));
        const rounded = Math.min(100 + (blocks - 1) * 100, 2000);
        const session = await prisma.parkingSession.create({
          data: {
            ticketNo: `T-${hex(4)}`, plate: v.plate, vehicleId: v.id, vehicleType: v.type, facilityId: info.f.id,
            spaceId: pick(spacesByFacility[info.f.id]).id, status: 'COMPLETED', entryAt, exitAt, durationMinutes: minutes,
            entryGateId: info.gateIn.id, exitGateId: info.gateOut.id, subtotal: rounded, total: rounded, amountPaid: rounded,
            breakdown: { demo: true }, createdAt: entryAt, enteredById: attendant.id, exitedById: attendant.id,
          },
        });
        const method = Math.random() < 0.55 ? 'CASH' : 'MOBILE_MONEY';
        const payment = await prisma.payment.create({
          data: {
            reference: `PAY-DEMO-${hex(5)}`, sessionId: session.id, facilityId: info.f.id, amount: rounded, method, status: 'SUCCESS',
            provider: method === 'CASH' ? 'cash' : 'momo-sim', providerReference: method === 'CASH' ? undefined : `SIM-${hex(6)}`,
            isSimulated: method !== 'CASH', paidAt: exitAt, receivedById: attendant.id, createdAt: exitAt,
            reconciledAt: d > 1 ? new Date(exitAt.getTime() + 6 * 3600000) : null, reconciledById: d > 1 ? finance.id : null,
          },
        });
        await prisma.receipt.create({ data: { number: `RCT-DEMO-${hex(4)}`, paymentId: payment.id, issuedAt: exitAt, snapshot: { demo: true, plate: v.plate, amount: String(rounded), currency: 'RWF', method } } });
      }
    }
  }
  // A few failed / pending payments so the finance views have content
  const sample = await prisma.parkingSession.findFirst({ where: { status: 'COMPLETED' } });
  await prisma.payment.create({ data: { reference: `PAY-DEMO-${hex(5)}`, sessionId: sample.id, facilityId: sample.facilityId, amount: 1500, method: 'MOBILE_MONEY', status: 'FAILED', provider: 'momo-sim', providerReference: `SIM-${hex(6)}`, isSimulated: true, failureReason: 'Simulated decline: insufficient funds' } });

  // Currently parked vehicles (these occupy spaces)
  const parked = [];
  const kccFree = await prisma.parkingSpace.findMany({ where: { facilityId: kcc.id, status: 'AVAILABLE', type: 'STANDARD' }, orderBy: { code: 'asc' }, take: 24 });
  const kimFree = await prisma.parkingSpace.findMany({ where: { facilityId: kim.id, status: 'AVAILABLE', type: 'STANDARD' }, orderBy: { code: 'asc' }, take: 9 });
  let vi = 10;
  for (const [fac, gate, list] of [[kcc, kccIn, kccFree], [kim, kimIn, kimFree]]) {
    for (const sp of list) {
      const v = vehicles[vi++ % vehicles.length];
      if (v.status === 'RESTRICTED' || parked.includes(v.plate) || v.type === 'MOTORCYCLE') continue;
      parked.push(v.plate);
      const s = await prisma.parkingSession.create({
        data: { ticketNo: `T-${hex(4)}`, plate: v.plate, vehicleId: v.id, vehicleType: v.type, facilityId: fac.id, spaceId: sp.id, entryAt: new Date(Date.now() - rnd(10, 300) * 60000), entryGateId: gate.id, enteredById: attendant.id },
      });
      await prisma.parkingSpace.update({ where: { id: sp.id }, data: { status: 'OCCUPIED' } });
      await prisma.spaceStatusHistory.create({ data: { spaceId: sp.id, fromStatus: 'AVAILABLE', toStatus: 'OCCUPIED', sessionId: s.id, reason: 'Vehicle entry' } });
    }
  }

  // Permit + reservation + permit holder
  await prisma.parkingPermit.create({ data: { number: `PRM-${hex(3)}`, facilityId: kcc.id, plate: vehicles[0].plate, vehicleId: vehicles[0].id, holderName: owners[0], phone: '+250788000111', startsAt: new Date(Date.now() - 10 * 86400000), endsAt: new Date(Date.now() + 5 * 86400000), fee: 90000 } });
  const resSpace = await prisma.parkingSpace.findFirst({ where: { facilityId: kcc.id, status: 'AVAILABLE', type: 'STANDARD' }, orderBy: { code: 'desc' } });
  await prisma.reservation.create({ data: { code: `RSV-${hex(3)}`, facilityId: kcc.id, spaceId: resSpace.id, plate: vehicles[5].plate, customerName: owners[5], phone: '+250788222333', startAt: new Date(Date.now() + 4 * 3600000), endAt: new Date(Date.now() + 8 * 3600000), status: 'CONFIRMED', createdById: kccAdmin.id } });

  await prisma.notification.createMany({
    data: [
      { type: 'DEVICE_OFFLINE', severity: 'WARNING', title: 'Camera KCC Level 1 Cam is offline', message: 'Plate recognition is unavailable on this camera.', facilityId: kcc.id },
      { type: 'PAYMENT_FAILED', severity: 'WARNING', title: 'Payment failed', message: 'Simulated mobile money decline (demo data).', facilityId: kim.id },
      { type: 'INFO', severity: 'INFO', title: 'Demo data loaded', message: 'This installation contains simulated demo data. Cameras, gates and mobile money are simulations.' },
    ],
  });

  console.log(`Demo data created. Sign in with any seeded user using password: ${DEMO_PASSWORD}`);
  console.log('  admin@smartparking.rw (super admin) | manager.kcc@ (parking admin) | attendant.kcc@ | finance@ | viewer@  (all @smartparking.rw)');
}

try {
  await seedAdmin();
  if (demo) await seedDemo();
} finally {
  await prisma.$disconnect();
}
