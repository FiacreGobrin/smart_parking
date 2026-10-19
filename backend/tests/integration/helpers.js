import bcrypt from 'bcryptjs';
import request from 'supertest';
import { prisma } from '../../src/config/db.js';
import { createApp } from '../../src/app.js';

export const PASSWORD = 'Test#Passw0rd1';
export const app = createApp();
export const api = request(app);

export function assertTestDatabase() {
  if (!/test/i.test(process.env.DATABASE_URL || '')) {
    throw new Error('Refusing to run destructive integration tests against a non-test database');
  }
}

export async function resetDatabase() {
  assertTestDatabase();
  const rows = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

// Two facilities so cross-facility isolation can be tested.
export async function seedFixtures() {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const facA = await prisma.parkingFacility.create({ data: { code: 'TA', name: 'Test Facility A' } });
  const facB = await prisma.parkingFacility.create({ data: { code: 'TB', name: 'Test Facility B' } });
  await prisma.parkingSpace.createMany({
    data: [
      { facilityId: facA.id, code: 'A01' }, { facilityId: facA.id, code: 'A02' }, { facilityId: facA.id, code: 'A03' },
      { facilityId: facB.id, code: 'B01' },
    ],
  });
  let n = 0;
  const mk = (email, role, facilityId = null) => {
    n += 1;
    return prisma.user.create({
      data: {
        email, username: email.split('@')[0].replace(/[^a-z0-9]/g, '_'), name: email.split('@')[0], role, facilityId, passwordHash: hash,
        status: 'ACTIVE', phone: `+2507881000${String(n).padStart(2, '0')}`, nationalId: `1199800000000${String(n).padStart(3, '0')}`,
      },
    });
  };
  const users = {
    superAdmin: await mk('super@test.rw', 'SUPER_ADMIN'),
    adminA: await mk('admin.a@test.rw', 'PARKING_ADMIN', facAId(facA)),
    attendantA: await mk('att.a@test.rw', 'ATTENDANT', facA.id),
    attendantB: await mk('att.b@test.rw', 'ATTENDANT', facB.id),
    finance: await mk('fin@test.rw', 'FINANCE_OFFICER'),
    viewer: await mk('view@test.rw', 'VIEWER'),
  };
  // Deterministic tariff (the design's example): start 100, +100 per extra hour, daily cap 2000.
  await prisma.parkingRate.create({ data: { name: 'Parking - All vehicles - hour', service: 'PARKING', unit: 'HOUR', startPrice: 100, increment: 100, cap: 2000 } });
  await prisma.parkingRate.create({ data: { name: 'Car wash - All vehicles - visit', service: 'CAR_WASH', unit: 'VISIT', startPrice: 2000, increment: 0, cap: 4000 } });
  await prisma.parkingRate.create({ data: { name: 'Garage - All vehicles - day', service: 'GARAGE', unit: 'DAY', startPrice: 1500, increment: 0, cap: 1500 } });
  const gateIn = await prisma.gate.create({ data: { facilityId: facA.id, name: 'In', direction: 'ENTRY' } });
  const gateOut = await prisma.gate.create({ data: { facilityId: facA.id, name: 'Out', direction: 'EXIT' } });
  const camIn = await prisma.camera.create({ data: { facilityId: facA.id, gateId: gateIn.id, name: 'Cam In' } });
  return { facA, facB, users, gateIn, gateOut, camIn };
}
const facAId = (f) => f.id;

export async function login(email) {
  const res = await api.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });
