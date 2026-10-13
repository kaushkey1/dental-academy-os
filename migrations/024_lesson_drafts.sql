CREATE TABLE lesson_drafts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL,
 lesson_id uuid, base_revision integer CHECK(base_revision>0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 media_id uuid GENERATED ALWAYS AS (nullif(payload->>'mediaId','')::uuid) STORED,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','discarded','published')),
 published_lesson_id uuid, published_revision integer,
 created_by text NOT NULL, updated_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id,media_id) REFERENCES media_assets(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id,lesson_id) REFERENCES lessons(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id,published_lesson_id) REFERENCES lessons(tenant_id,offering_id,id),
 CHECK((lesson_id IS NULL)=(base_revision IS NULL)),
 CHECK((state='published')=(published_lesson_id IS NOT NULL AND published_revision IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_lesson_draft ON lesson_drafts(tenant_id,lesson_id) WHERE state='draft' AND lesson_id IS NOT NULL;
CREATE INDEX course_drafts ON lesson_drafts(tenant_id,offering_id,state,updated_at);
ALTER TABLE lesson_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lesson_drafts USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON lesson_drafts TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON lesson_drafts FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
INSERT INTO schema_migrations(version) VALUES(24);
