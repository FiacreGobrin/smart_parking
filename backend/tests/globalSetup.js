import { execSync } from 'node:child_process';

// Applies migrations to the test database once before the suite. Unit tests do not need it,
// so a missing database only fails the integration tests.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:54329/smartparking_test';
  if (/smartparking(?!_test)\b/.test(url) && !process.env.TEST_DATABASE_URL) return;
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    });
  } catch (err) {
    console.warn('[tests] could not migrate the test database. Integration tests will fail.\n', String(err.stderr || err.message).slice(0, 400));
  }
}
