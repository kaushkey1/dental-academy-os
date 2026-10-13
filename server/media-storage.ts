import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { development } from './config.ts';
import { assert } from './errors.ts';
export interface MediaStorage {
  kind: 'local' | 'gcs';
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export function localMediaStorage(root = '.local/media'): MediaStorage {
  assert(development, 'Local media storage is only available in development', 503);
  const file = (key: string) => {
    assert(
      /^[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9]{64}\.(pdf|png|jpg)$/.test(key),
      'Invalid document path',
    );
    return resolve(root, key);
  };
  return {
    kind: 'local',
    async put(key, bytes) {
      const dest = file(key);
      await mkdir(dirname(dest), { recursive: true });
      const temp = dest + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temp, dest);
      } finally {
        await unlink(temp).catch(() => {});
      }
    },
    get(key) {
      return readFile(file(key));
    },
  };
}
export function configuredStorage(): MediaStorage | undefined {
  if (process.env.GCS_MEDIA_BUCKET) {
    const bucket = new Storage().bucket(process.env.GCS_MEDIA_BUCKET);
    return {
      kind: 'gcs',
      async put(key, bytes, contentType = 'application/pdf') {
        const file = bucket.file(key);
        try {
          await file.save(bytes, {
            resumable: false,
            validation: 'crc32c',
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { contentType, cacheControl: 'private, no-store' },
          });
        } catch (e) {
          if ((e as { code: number }).code !== 412) throw e;
          const [existing] = await file.download();
          assert(
            createHash('sha256').update(existing).digest('hex') ===
              createHash('sha256').update(bytes).digest('hex'),
            'Stored document conflicts with this upload',
            409,
          );
        }
      },
      async get(key) {
        const [bytes] = await bucket.file(key).download();
        return bytes;
      },
    };
  }
  return development ? localMediaStorage() : undefined;
}
