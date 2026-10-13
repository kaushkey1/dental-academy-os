CREATE TABLE media_assets (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pdf','video')), name text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('local','gcs','mux')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','creating','uploading','processing','ready','error','unknown')),
 byte_size bigint NOT NULL CHECK(byte_size>0), mime_type text NOT NULL,
 storage_key text, sha256 text, page_count integer,
 provider_upload_id text, provider_asset_id text, playback_id text,
 duration_seconds integer, last_error text, archived_at timestamptz,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id),
 UNIQUE(tenant_id,provider_upload_id), UNIQUE(tenant_id,provider_asset_id),
 CHECK(status<>'ready' OR (kind='pdf' AND storage_key IS NOT NULL AND sha256 IS NOT NULL AND page_count>0) OR (kind='video' AND playback_id IS NOT NULL AND duration_seconds>0))
);
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_assets USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON media_assets TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON media_assets FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
ALTER TABLE lessons ADD COLUMN media_id uuid;
ALTER TABLE lessons ADD CONSTRAINT lesson_media_fk FOREIGN KEY(tenant_id,offering_id,media_id) REFERENCES media_assets(tenant_id,offering_id,id);
ALTER TABLE progress ADD COLUMN document_opened_at timestamptz;
CREATE INDEX course_media ON media_assets(tenant_id,offering_id,created_at);
INSERT INTO schema_migrations(version) VALUES(8);
