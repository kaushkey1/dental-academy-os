CREATE TABLE cancellation_policies (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id), revision integer NOT NULL CHECK(revision>0),
 config jsonb NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 1000),
 reviewed_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,revision), FOREIGN KEY(tenant_id,reviewed_by) REFERENCES staff(tenant_id,id)
);
ALTER TABLE cancellation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cancellation_policies USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON cancellation_policies TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT ON cancellation_policies FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
ALTER TABLE orders ADD COLUMN cancellation_policy jsonb;
CREATE FUNCTION guard_order_cancellation_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.cancellation_policy IS NOT NULL AND NEW.cancellation_policy IS DISTINCT FROM OLD.cancellation_policy THEN
 RAISE EXCEPTION 'Accepted cancellation terms cannot be rewritten' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_cancellation_policy BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_cancellation_policy();
INSERT INTO schema_migrations(version) VALUES(21);
