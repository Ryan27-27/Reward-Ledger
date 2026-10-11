import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.isTest ? 'silent' : process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.otp', '*.code'],
});
