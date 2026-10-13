ALTER TABLE payments ADD COLUMN unallocated_refunded integer NOT NULL DEFAULT 0 CHECK(unallocated_refunded>=0 AND unallocated_refunded<=amount-allocated_amount AND (kind='charge' OR unallocated_refunded=0));
ALTER TABLE orders ADD COLUMN excess_refunded bigint NOT NULL DEFAULT 0 CHECK(excess_refunded>=0);
CREATE TABLE excess_refund_requests (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, payment_id uuid NOT NULL,
 amount integer NOT NULL CHECK(amount>0), currency text NOT NULL,
 requested_staff_id uuid, requested_contact_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 1000),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected','withdrawn','succeeded')),
 decided_by uuid, decided_at timestamptz, decision_note text, buyer_message text,
 completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,payment_id) REFERENCES payments(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,requested_staff_id) REFERENCES staff(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,decided_by) REFERENCES staff(tenant_id,id),
 CHECK((requested_staff_id IS NULL)<>(requested_contact_id IS NULL)),
 CHECK((status IN ('requested','withdrawn') AND decided_at IS NULL AND decided_by IS NULL) OR (status IN ('approved','rejected','succeeded') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)),
 CHECK((status='succeeded')=(completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_excess_refund ON excess_refund_requests(tenant_id,payment_id) WHERE status IN ('requested','approved');
CREATE TABLE refund_attempts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, refund_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('stripe','razorpay','offline')),
 charge_ref text NOT NULL, amount integer NOT NULL CHECK(amount>0), currency text NOT NULL,
 status text NOT NULL CHECK(status IN ('creating','uncertain','pending','requires_action','succeeded','failed','cancelled')),
 provider_ref text, provider_snapshot jsonb, last_error text, lease_id uuid, lease_until timestamptz,
 offline_evidence jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,id), UNIQUE(tenant_id,provider,provider_ref),
 FOREIGN KEY(tenant_id,order_id,refund_id) REFERENCES excess_refund_requests(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES staff(tenant_id,id),
 CHECK((provider='offline')=(offline_evidence IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_refund_attempt ON refund_attempts(tenant_id,refund_id) WHERE status NOT IN ('failed','cancelled');
CREATE UNIQUE INDEX one_offline_return_reference ON refund_attempts(tenant_id,(offline_evidence->>'referenceKey')) WHERE provider='offline';
ALTER TABLE payments ADD COLUMN original_payment_id uuid, ADD COLUMN refund_attempt_id uuid;
ALTER TABLE payments ADD FOREIGN KEY(tenant_id,order_id,original_payment_id) REFERENCES payments(tenant_id,order_id,id);
ALTER TABLE payments ADD FOREIGN KEY(tenant_id,order_id,refund_attempt_id) REFERENCES refund_attempts(tenant_id,order_id,id);
ALTER TABLE payments ADD CONSTRAINT refund_payment_reference CHECK((original_payment_id IS NULL AND refund_attempt_id IS NULL) OR (kind='refund' AND original_payment_id IS NOT NULL AND refund_attempt_id IS NOT NULL));
CREATE UNIQUE INDEX one_refund_payment ON payments(tenant_id,refund_attempt_id) WHERE refund_attempt_id IS NOT NULL;
CREATE FUNCTION guard_excess_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.payment_id,NEW.amount,NEW.currency,NEW.requested_staff_id,NEW.requested_contact_id,NEW.reason,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.payment_id,OLD.amount,OLD.currency,OLD.requested_staff_id,OLD.requested_contact_id,OLD.reason,OLD.created_at)
 OR (OLD.status IN ('rejected','withdrawn','succeeded') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.status='approved' AND (NEW.status NOT IN ('approved','succeeded') OR (NEW.decided_by,NEW.decided_at,NEW.decision_note,NEW.buyer_message) IS DISTINCT FROM (OLD.decided_by,OLD.decided_at,OLD.decision_note,OLD.buyer_message))) THEN
 RAISE EXCEPTION 'Refund request and decisions cannot be rewritten' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_refund_request BEFORE UPDATE ON excess_refund_requests FOR EACH ROW EXECUTE FUNCTION guard_excess_refund();
CREATE FUNCTION guard_refund_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.refund_id,NEW.provider,NEW.charge_ref,NEW.amount,NEW.currency,NEW.offline_evidence,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.refund_id,OLD.provider,OLD.charge_ref,OLD.amount,OLD.currency,OLD.offline_evidence,OLD.created_by,OLD.created_at)
 OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
 OR (OLD.status IN ('succeeded','failed','cancelled') AND NEW IS DISTINCT FROM OLD) THEN
 RAISE EXCEPTION 'Refund attempt identity and terminal evidence cannot be rewritten' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_refund_attempt BEFORE UPDATE ON refund_attempts FOR EACH ROW EXECUTE FUNCTION guard_refund_attempt();
CREATE OR REPLACE FUNCTION guard_recorded_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.allocated_amount := CASE WHEN NEW.kind='charge' AND NEW.applied THEN NEW.amount ELSE 0 END;
 ELSE
  IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.provider_ref,NEW.amount,NEW.kind,NEW.attempt_id,NEW.offline_payment_id,NEW.review_reason,NEW.created_at,NEW.original_payment_id,NEW.refund_attempt_id)
  IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.provider_ref,OLD.amount,OLD.kind,OLD.attempt_id,OLD.offline_payment_id,OLD.review_reason,OLD.created_at,OLD.original_payment_id,OLD.refund_attempt_id)
  OR NEW.allocated_amount<OLD.allocated_amount OR NEW.unallocated_refunded<OLD.unallocated_refunded THEN
   RAISE EXCEPTION 'Recorded money and its original evidence cannot be rewritten' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['excess_refund_requests','refund_attempts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO academy_app',t);
 EXECUTE format('CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_staff_write()',t);
 END LOOP;
END $$;
CREATE INDEX excess_refund_queue ON excess_refund_requests(tenant_id,status,created_at,id);
-- Refund confirmations have their own annual series; original invoices and receipts remain immutable.
ALTER TABLE billing_sequences DROP CONSTRAINT billing_sequences_kind_check;
ALTER TABLE billing_sequences ADD CHECK(kind IN ('invoice','receipt','refund_receipt'));
ALTER TABLE billing_documents DROP CONSTRAINT billing_documents_kind_check;
ALTER TABLE billing_documents ADD CHECK(kind IN ('invoice','receipt','refund_receipt'));
ALTER TABLE billing_documents DROP CONSTRAINT billing_documents_check;
ALTER TABLE billing_documents ADD CHECK((kind IN ('receipt','refund_receipt'))=(payment_id IS NOT NULL));
CREATE UNIQUE INDEX one_refund_receipt ON billing_documents(tenant_id,payment_id) WHERE kind='refund_receipt';
INSERT INTO schema_migrations(version) VALUES(20);
