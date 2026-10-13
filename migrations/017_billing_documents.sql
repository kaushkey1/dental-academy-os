ALTER TABLE orders ADD COLUMN billing_context jsonb;
CREATE TABLE billing_profiles (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(tenant_id), revision integer NOT NULL DEFAULT 0,
 config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_sequences (
 tenant_id uuid NOT NULL REFERENCES tenants(tenant_id), kind text NOT NULL CHECK(kind IN ('invoice','receipt')),
 financial_year integer NOT NULL, last_number integer NOT NULL CHECK(last_number BETWEEN 1 AND 999999),
 PRIMARY KEY(tenant_id,kind,financial_year)
);
ALTER TABLE payments ADD CONSTRAINT payment_order_identity UNIQUE(tenant_id,order_id,id);
CREATE TABLE billing_documents (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, payment_id uuid,
 kind text NOT NULL CHECK(kind IN ('invoice','receipt')), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued')),
 source jsonb NOT NULL, recipient jsonb NOT NULL, blockers jsonb NOT NULL DEFAULT '[]',
 number text, financial_year integer, issued_at timestamptz, snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,number),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,payment_id) REFERENCES payments(tenant_id,order_id,id),
 CHECK((kind='receipt')=(payment_id IS NOT NULL)),
 CHECK((status='issued' AND number IS NOT NULL AND length(number)<=16 AND financial_year IS NOT NULL AND issued_at IS NOT NULL AND snapshot IS NOT NULL)
    OR (status='pending' AND number IS NULL AND financial_year IS NULL AND issued_at IS NULL AND snapshot IS NULL))
);
CREATE UNIQUE INDEX one_order_invoice ON billing_documents(tenant_id,order_id) WHERE kind='invoice';
CREATE UNIQUE INDEX one_payment_receipt ON billing_documents(tenant_id,payment_id) WHERE kind='receipt';
CREATE INDEX billing_document_queue ON billing_documents(tenant_id,status,created_at,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['billing_profiles','billing_sequences','billing_documents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO academy_app',t);
  EXECUTE format('CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_staff_write()',t);
 END LOOP;
END $$;
CREATE FUNCTION guard_billing_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='issued' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Issued billing documents are immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.payment_id,NEW.kind,NEW.source,NEW.created_at)
  IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.payment_id,OLD.kind,OLD.source,OLD.created_at) THEN
  RAISE EXCEPTION 'Billing document source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_billing_document BEFORE UPDATE ON billing_documents FOR EACH ROW EXECUTE FUNCTION guard_billing_document();
INSERT INTO schema_migrations(version) VALUES(17);
