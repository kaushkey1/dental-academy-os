CREATE TABLE billing_document_files (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL, bytes bytea NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES billing_documents(tenant_id,id),
 CHECK(octet_length(bytes) BETWEEN 1 AND 2097152)
);
ALTER TABLE billing_document_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_document_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_document_files USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON billing_document_files TO academy_app;
CREATE FUNCTION guard_billing_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.kind,NEW.financial_year) IS DISTINCT FROM (OLD.tenant_id,OLD.kind,OLD.financial_year)
    OR NEW.last_number<>OLD.last_number+1 THEN
  RAISE EXCEPTION 'Billing sequences may only advance by one' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_billing_sequence BEFORE UPDATE ON billing_sequences FOR EACH ROW EXECUTE FUNCTION guard_billing_sequence();
INSERT INTO schema_migrations(version) VALUES(18);
