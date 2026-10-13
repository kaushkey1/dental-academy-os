CREATE TABLE offering_faculty (
 tenant_id uuid NOT NULL, offering_id uuid NOT NULL, staff_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,offering_id,staff_id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);
ALTER TABLE offering_faculty ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_faculty FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offering_faculty
 USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON offering_faculty TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE OR DELETE ON offering_faculty
 FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
INSERT INTO schema_migrations(version) VALUES(4);
