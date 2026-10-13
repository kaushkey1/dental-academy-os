import { randomBytes } from 'node:crypto';
export const production = process.env.NODE_ENV === 'production';
export const development = !production && process.env.APP_MODE !== 'production';
export const demo = process.env.DEMO_MODE === 'true';
export const origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173';
export const sessionSecret =
  process.env.SESSION_SECRET || (development ? randomBytes(48).toString('hex') : '');
export function validateEnvironment() {
  if (demo) {
    if ((process.env.DEMO_ACCESS_CODE || '').length < 20 || !process.env.DEMO_IDENTITIES_JSON)
      throw new Error('Demo requires a strong access code and explicit demo identities');
    if (
      process.env.TENANT_SECRETS_JSON ||
      process.env.RESEND_API_KEY ||
      process.env.TWILIO_AUTH_TOKEN
    )
      throw new Error('Live payment and messaging credentials must not be configured in demo mode');
  }
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
