ALTER TABLE media_assets DROP CONSTRAINT media_assets_provider_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_provider_check CHECK(provider IN ('local','gcs','mux','netlify'));
ALTER TABLE offline_payments DROP CONSTRAINT offline_payments_storage_kind_check;
ALTER TABLE offline_payments ADD CONSTRAINT offline_payments_storage_kind_check CHECK(storage_kind IN ('local','gcs','netlify'));
INSERT INTO schema_migrations(version) VALUES(26);
