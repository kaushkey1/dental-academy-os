ALTER TABLE orders ADD COLUMN cancellation_pending boolean NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN applied_refunded integer NOT NULL DEFAULT 0 CHECK(applied_refunded>=0 AND applied_refunded<=allocated_amount AND (kind='charge' OR applied_refunded=0));
CREATE TABLE booking_cancellations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL,
 requested_staff_id uuid, requested_contact_id uuid, reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 1000),
 quote jsonb NOT NULL, status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected','withdrawn')),
 decision_data jsonb, decided_by uuid, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_staff_id) REFERENCES staff(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,decided_by) REFERENCES staff(tenant_id,id),
 CHECK((requested_staff_id IS NULL)<>(requested_contact_id IS NULL)),
 CHECK((status='requested' AND decision_data IS NULL AND decided_at IS NULL AND decided_by IS NULL) OR (status<>'requested' AND decision_data IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_cancellation ON booking_cancellations(tenant_id,order_id) WHERE status IN ('requested','approved');
ALTER TABLE booking_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON booking_cancellations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON booking_cancellations TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON booking_cancellations FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
CREATE FUNCTION guard_booking_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.requested_staff_id,NEW.requested_contact_id,NEW.reason,NEW.quote,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.requested_staff_id,OLD.requested_contact_id,OLD.reason,OLD.quote,OLD.created_at)
 OR (OLD.status<>'requested' AND NEW IS DISTINCT FROM OLD) THEN
 RAISE EXCEPTION 'Cancellation request and final decision are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_cancellation BEFORE UPDATE ON booking_cancellations FOR EACH ROW EXECUTE FUNCTION guard_booking_cancellation();
ALTER TABLE excess_refund_requests RENAME TO refund_requests;
ALTER TABLE refund_requests ADD COLUMN kind text NOT NULL DEFAULT 'excess' CHECK(kind IN ('excess','cancellation'));
ALTER TABLE refund_requests ADD COLUMN applied_amount integer NOT NULL DEFAULT 0 CHECK(applied_amount>=0 AND applied_amount<=amount);
ALTER TABLE refund_requests ADD COLUMN cancellation_id uuid;
ALTER TABLE refund_requests ADD FOREIGN KEY(tenant_id,order_id,cancellation_id) REFERENCES booking_cancellations(tenant_id,order_id,id);
ALTER TABLE refund_requests ADD CHECK((kind='excess' AND cancellation_id IS NULL AND applied_amount=0) OR (kind='cancellation' AND cancellation_id IS NOT NULL));
CREATE OR REPLACE FUNCTION guard_excess_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.payment_id,NEW.amount,NEW.currency,NEW.requested_staff_id,NEW.requested_contact_id,NEW.reason,NEW.created_at,NEW.kind,NEW.applied_amount,NEW.cancellation_id)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.payment_id,OLD.amount,OLD.currency,OLD.requested_staff_id,OLD.requested_contact_id,OLD.reason,OLD.created_at,OLD.kind,OLD.applied_amount,OLD.cancellation_id)
 OR (OLD.status IN ('rejected','withdrawn','succeeded') AND NEW IS DISTINCT FROM OLD)
 OR (OLD.status='approved' AND (NEW.status NOT IN ('approved','succeeded') OR (NEW.decided_by,NEW.decided_at,NEW.decision_note,NEW.buyer_message) IS DISTINCT FROM (OLD.decided_by,OLD.decided_at,OLD.decision_note,OLD.buyer_message))) THEN
 RAISE EXCEPTION 'Refund request and decisions cannot be rewritten' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_recorded_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.allocated_amount:=CASE WHEN NEW.kind='charge' AND NEW.applied THEN NEW.amount ELSE 0 END;
 ELSE
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.provider_ref,NEW.amount,NEW.kind,NEW.attempt_id,NEW.offline_payment_id,NEW.review_reason,NEW.created_at,NEW.original_payment_id,NEW.refund_attempt_id)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.provider_ref,OLD.amount,OLD.kind,OLD.attempt_id,OLD.offline_payment_id,OLD.review_reason,OLD.created_at,OLD.original_payment_id,OLD.refund_attempt_id)
 OR NEW.allocated_amount<OLD.allocated_amount OR NEW.unallocated_refunded<OLD.unallocated_refunded OR NEW.applied_refunded<OLD.applied_refunded THEN
 RAISE EXCEPTION 'Recorded money and its original evidence cannot be rewritten' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER TABLE billing_sequences DROP CONSTRAINT billing_sequences_kind_check;
ALTER TABLE billing_sequences ADD CHECK(kind IN ('invoice','receipt','refund_receipt','credit_note','cancellation_statement'));
ALTER TABLE billing_documents DROP CONSTRAINT billing_documents_kind_check;
ALTER TABLE billing_documents ADD CHECK(kind IN ('invoice','receipt','refund_receipt','credit_note','cancellation_statement'));
ALTER TABLE billing_documents ADD COLUMN cancellation_id uuid, ADD COLUMN original_document_id uuid;
ALTER TABLE billing_documents ADD FOREIGN KEY(tenant_id,order_id,cancellation_id) REFERENCES booking_cancellations(tenant_id,order_id,id);
ALTER TABLE billing_documents ADD CONSTRAINT document_order_identity UNIQUE(tenant_id,order_id,id);
ALTER TABLE billing_documents ADD FOREIGN KEY(tenant_id,order_id,original_document_id) REFERENCES billing_documents(tenant_id,order_id,id);
CREATE UNIQUE INDEX one_cancellation_document ON billing_documents(tenant_id,cancellation_id) WHERE cancellation_id IS NOT NULL;
CREATE OR REPLACE FUNCTION guard_billing_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='issued' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Issued billing documents are immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.payment_id,NEW.kind,NEW.source,NEW.created_at,NEW.cancellation_id,NEW.original_document_id)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.payment_id,OLD.kind,OLD.source,OLD.created_at,OLD.cancellation_id,OLD.original_document_id) THEN
 RAISE EXCEPTION 'Billing document source is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(22);
