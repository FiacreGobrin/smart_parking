import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // A parking transaction runs several statements. Against a remote database (Neon is hosted in another
  // region) the default 5 s limit is too short, which surfaces as "Transaction not found".
  transactionOptions: { maxWait: 15000, timeout: 45000 },
});
