import { randomBytes } from 'node:crypto';
export const production = process.env.NODE_ENV === 'production';
export const development = !production && process.env.APP_MODE !== 'production';
export const origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173';
export const sessionSecret =
  process.env.SESSION_SECRET || (development ? randomBytes(48).toString('hex') : '');
export function validateEnvironment() {
  if (!development) {
    for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'PUBLIC_ORIGIN'])
      if (!process.env[key]) throw new Error(`${key} is required in production`);
    if (sessionSecret.length < 32)
      throw new Error('SESSION_SECRET must contain at least 32 random characters');
    if (!origin.startsWith('https://'))
      throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
    if (process.env.APP_MODE !== 'production')
      throw new Error('Set APP_MODE=production for a production release');
  }
}
export function tenantSecrets(id: string): Record<string, string> {
  return JSON.parse(process.env.TENANT_SECRETS_JSON || '{}')[id] || {};
}
