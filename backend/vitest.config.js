import { defineConfig } from 'vitest/config';

// Integration tests run against a dedicated database (never the development one).
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:54329/smartparking_test';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DB,
      DIRECT_DATABASE_URL: TEST_DB,
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      FRONTEND_URL: 'http://localhost:5173',
      UPLOAD_DIR: 'uploads-test',
      ANPR_MODE: 'simulation',
      PAYMENT_MODE: 'simulation',
      MOMO_WEBHOOK_SECRET: 'test-webhook-secret',
      ANPR_DEDUP_SECONDS: '30',
    },
  },
});
