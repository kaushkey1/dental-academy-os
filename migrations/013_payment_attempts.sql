ALTER TABLE orders ADD COLUMN balance_due_at timestamptz;
ALTER TABLE orders ADD COLUMN reservation_request jsonb;
CREATE TABLE payment_attempts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('initial','balance')),
 provider text NOT NULL CHECK(provider IN ('stripe','razorpay')),
 amount integer NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency IN ('INR','USD')),
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','uncertain','ready','paid','expired','cancelled','review_required')),
 request jsonb NOT NULL, provider_ref text, payment_url text,
 expires_at timestamptz NOT NULL, provider_snapshot jsonb,
 lease_id uuid, lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,id), UNIQUE(tenant_id,provider,provider_ref),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE UNIQUE INDEX one_open_payment_attempt ON payment_attempts(tenant_id,order_id,purpose)
 WHERE status IN ('creating','uncertain','ready');
ALTER TABLE payments ADD COLUMN attempt_id uuid;
ALTER TABLE payments ADD COLUMN applied boolean NOT NULL DEFAULT true;
ALTER TABLE payments ADD COLUMN review_reason text;
ALTER TABLE payments ADD CONSTRAINT payment_attempt_order FOREIGN KEY(tenant_id,order_id,attempt_id) REFERENCES payment_attempts(tenant_id,order_id,id);
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_attempts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON payment_attempts TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
INSERT INTO schema_migrations(version) VALUES(13);
