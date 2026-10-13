CREATE TABLE offline_payments (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('initial','balance')),
 amount integer NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency IN ('INR','USD')),
 method text NOT NULL CHECK(method IN ('bank_transfer','cash','cheque')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 3 AND 120), reference_key text NOT NULL,
 received_at timestamptz NOT NULL, note text NOT NULL CHECK(length(note) BETWEEN 5 AND 1000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected','withdrawn')),
 proof_name text NOT NULL, proof_mime text NOT NULL CHECK(proof_mime IN ('application/pdf','image/png','image/jpeg')),
 proof_size integer NOT NULL CHECK(proof_size BETWEEN 1 AND 5242880), proof_sha256 text, storage_key text, storage_kind text CHECK(storage_kind IN ('local','gcs')),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
 reviewed_by uuid, reviewed_at timestamptz, decision_reason text,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES staff(tenant_id,id),
 FOREIGN KEY(tenant_id,reviewed_by) REFERENCES staff(tenant_id,id),
 CHECK((proof_sha256 IS NULL AND storage_key IS NULL AND storage_kind IS NULL) OR
       (proof_sha256 IS NOT NULL AND storage_key IS NOT NULL AND storage_kind IS NOT NULL)),
 CHECK(status NOT IN ('pending','approved','rejected') OR (proof_sha256 IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK((status IN ('approved','rejected','withdrawn')) = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND length(decision_reason)>=5))
);
CREATE UNIQUE INDEX unique_offline_reference ON offline_payments(tenant_id,method,reference_key) WHERE status IN ('draft','pending','approved');
CREATE UNIQUE INDEX one_pending_offline_payment ON offline_payments(tenant_id,order_id) WHERE status='pending';
CREATE INDEX offline_payment_queue ON offline_payments(tenant_id,status,created_at DESC,id);
ALTER TABLE payments ADD COLUMN offline_payment_id uuid;
ALTER TABLE payments ADD CONSTRAINT offline_payment_order FOREIGN KEY(tenant_id,order_id,offline_payment_id) REFERENCES offline_payments(tenant_id,order_id,id);
CREATE UNIQUE INDEX one_offline_posting ON payments(tenant_id,offline_payment_id) WHERE offline_payment_id IS NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payment_source_exclusive CHECK(attempt_id IS NULL OR offline_payment_id IS NULL);
ALTER TABLE offline_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offline_payments USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON offline_payments TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON offline_payments FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
CREATE FUNCTION guard_offline_payment_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.purpose,NEW.amount,NEW.currency,NEW.method,NEW.reference,NEW.reference_key,NEW.received_at,NEW.note,NEW.proof_name,NEW.proof_mime,NEW.proof_size,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.purpose,OLD.amount,OLD.currency,OLD.method,OLD.reference,OLD.reference_key,OLD.received_at,OLD.note,OLD.proof_name,OLD.proof_mime,OLD.proof_size,OLD.created_by,OLD.created_at) THEN
 RAISE EXCEPTION 'Offline payment details are immutable; withdraw or reject the record and create a correction' USING ERRCODE='23514';
 END IF;
 IF OLD.proof_sha256 IS NOT NULL AND (NEW.proof_sha256,NEW.storage_key,NEW.storage_kind) IS DISTINCT FROM (OLD.proof_sha256,OLD.storage_key,OLD.storage_kind) THEN
 RAISE EXCEPTION 'Payment proof is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status IN ('approved','rejected','withdrawn') AND NEW IS DISTINCT FROM OLD THEN
 RAISE EXCEPTION 'An offline payment decision is final' USING ERRCODE='23514';
 END IF;
 IF NEW.status<>OLD.status AND NOT ((OLD.status='draft' AND NEW.status IN ('pending','withdrawn')) OR (OLD.status='pending' AND NEW.status IN ('approved','rejected','withdrawn'))) THEN
 RAISE EXCEPTION 'Invalid offline payment transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_offline_payment BEFORE UPDATE ON offline_payments FOR EACH ROW EXECUTE FUNCTION guard_offline_payment_record();
INSERT INTO schema_migrations(version) VALUES(15);
