import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(5),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ANPR: "ocr" (built-in Tesseract, best effort), "http" (external engine) or "simulation" (typed plate, tests only)
  ANPR_MODE: z.enum(['simulation', 'ocr', 'http']).default('ocr'),
  ANPR_SERVICE_URL: z.string().optional(),
  ANPR_SERVICE_TOKEN: z.string().optional(),
  ANPR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  ANPR_DEDUP_SECONDS: z.coerce.number().default(30),

  // Payments: "simulation" lets the dev UI trigger a signed provider callback.
  PAYMENT_MODE: z.enum(['simulation', 'live']).default('simulation'),
  MOMO_WEBHOOK_SECRET: z.string().optional(),
  MOMO_API_BASE_URL: z.string().optional(),
  MOMO_API_KEY: z.string().optional(),

  // SMS: "simulation" records messages without sending; "http" posts to a gateway.
  SMS_MODE: z.enum(['simulation', 'africastalking', 'http']).default('simulation'),
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),
  SMS_API_URL: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER: z.string().optional(),

  GATE_COMMAND_TIMEOUT_MS: z.coerce.number().default(4000),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const frontendOrigins = env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean);
// The webhook secret falls back to a derived value only outside production.
export const momoSecret = env.MOMO_WEBHOOK_SECRET || (isProd ? null : `${env.JWT_SECRET}:momo-sim`);
