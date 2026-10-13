CREATE TABLE webhook_inbox (
 tenant_id uuid NOT NULL, provider text NOT NULL, event_id text NOT NULL,
 raw_body text NOT NULL, status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','ignored','failed')),
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, last_error text,
 PRIMARY KEY(tenant_id,provider,event_id)
);
ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_inbox USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON webhook_inbox TO academy_app;
CREATE INDEX webhook_inbox_pending ON webhook_inbox(tenant_id,status,received_at);
INSERT INTO schema_migrations(version) VALUES(2);
