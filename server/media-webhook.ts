import express, { type Express } from 'express';
import { z } from 'zod';
import { one, tenantTx, type Database } from './db.ts';
import { assert, requireValue } from './errors.ts';
import { validateSignature } from './providers.ts';
import { syncAsset, type MediaServices } from './media.ts';
export function registerMediaWebhook(app: Express, db: Database, services: MediaServices) {
  app.post(
    '/api/media/webhooks/mux',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      assert(process.env.MUX_WEBHOOK_SECRET, 'Video webhook is not configured', 503);
      assert(
        Buffer.isBuffer(req.body) &&
          validateSignature(
            'stripe',
            req.body,
            req.get('mux-signature') || '',
            process.env.MUX_WEBHOOK_SECRET,
          ),
        'Invalid video webhook signature',
        401,
      );
      const payload = JSON.parse(req.body.toString());
      // Process asset events using a fresh provider read, never an out-of-order payload's readiness claim.
      if (
        ![
          'video.asset.ready',
          'video.asset.errored',
          'video.asset.created',
          'video.asset.deleted',
        ].includes(payload.type)
      ) {
        res.json({ ignored: true });
        return;
      }
      const [tenant, id] = String(payload.data?.passthrough || '').split(':');
      if (
        !z.string().uuid().safeParse(tenant).success ||
        !z.string().uuid().safeParse(id).success
      ) {
        res.json({ ignored: true });
        return;
      }
      const eventId = z.string().min(1).max(200).parse(payload.id);
      requireValue(await one(db, 'SELECT id FROM tenant_directory WHERE id=$1', [tenant]));
      await tenantTx(db, tenant, 'system', (tx) =>
        tx.query(
          "INSERT INTO webhook_inbox(tenant_id,provider,event_id,raw_body) VALUES($1,'mux',$2,$3) ON CONFLICT DO NOTHING",
          [tenant, eventId, req.body.toString()],
        ),
      );
      try {
        const prior = await tenantTx(db, tenant, 'system', (tx) =>
          one(tx, "SELECT status FROM webhook_inbox WHERE provider='mux' AND event_id=$1", [
            eventId,
          ]),
        );
        if (prior?.status === 'processed') {
          res.json({ duplicate: true });
          return;
        }
        const m = await tenantTx(db, tenant, 'system', (tx) =>
          one(tx, "SELECT provider_asset_id FROM media_assets WHERE id=$1 AND kind='video'", [id]),
        );
        requireValue(m, 'Media record not found');
        assert(
          !m!.provider_asset_id || m!.provider_asset_id === payload.data.id,
          'Conflicting video reference',
          409,
        );
        assert(services.video, 'Video provider is not configured', 503);
        const asset =
          payload.type === 'video.asset.deleted'
            ? { ...payload.data, status: 'deleted' }
            : await services.video.asset(payload.data.id);
        await syncAsset(db, tenant, id, asset);
        await tenantTx(db, tenant, 'system', (tx) =>
          tx.query(
            "UPDATE webhook_inbox SET status='processed',processed_at=now(),last_error=NULL WHERE provider='mux' AND event_id=$1",
            [eventId],
          ),
        );
        res.json({ received: true });
      } catch (e) {
        await tenantTx(db, tenant, 'system', (tx) =>
          tx.query(
            "UPDATE webhook_inbox SET status='failed',last_error=$1 WHERE provider='mux' AND event_id=$2",
            [(e as Error).message.slice(0, 500), eventId],
          ),
        );
        throw e;
      }
    },
  );
}
