import { env } from './env.js';

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[env.LOG_LEVEL];

function write(level, msg, meta) {
  if (levels[level] < threshold) return;
  if (env.NODE_ENV === 'test') return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
