import { origin } from './config.ts';
import { AppError, assert } from './errors.ts';
import type { Row } from './db.ts';
export interface VideoProvider {
  create(passthrough: string): Promise<Row>;
  upload(id: string): Promise<Row>;
  asset(id: string): Promise<Row>;
  find(passthrough: string): Promise<Row | undefined>;
}
export function configuredVideoProvider(): VideoProvider | undefined {
  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) return;
  const auth =
    'Basic ' +
    Buffer.from(process.env.MUX_TOKEN_ID + ':' + process.env.MUX_TOKEN_SECRET).toString('base64');
  async function call(path: string, body?: Row) {
    const response = await fetch('https://api.mux.com/video/v1/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new AppError(
        502,
        `The video service returned ${response.status}. Refresh status before starting another upload.`,
      );
    return (await response.json()).data;
  }
  const id = (value: string) => {
    assert(/^[A-Za-z0-9_-]+$/.test(value), 'Invalid video reference');
    return encodeURIComponent(value);
  };
  return {
    create: (passthrough) =>
      call('uploads', {
        cors_origin: origin,
        timeout: 86400,
        new_asset_settings: { playback_policies: ['signed'], video_quality: 'basic', passthrough },
      }),
    upload: (value) => call('uploads/' + id(value)),
    asset: (value) => call('assets/' + id(value)),
    async find(passthrough) {
      for (let page = 1; page <= 5; page++) {
        const rows: Row[] = await call('uploads?limit=100&page=' + page);
        const found = rows.find((v) => v.new_asset_settings?.passthrough === passthrough);
        if (found) return found;
        if (rows.length < 100) return;
      }
    },
  };
}
