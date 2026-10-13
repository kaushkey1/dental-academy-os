ALTER TABLE payments ADD COLUMN allocated_amount integer;
UPDATE payments SET allocated_amount=CASE WHEN kind='charge' AND applied THEN amount ELSE 0 END;
ALTER TABLE payments ALTER COLUMN allocated_amount SET NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payment_allocation_bounds CHECK(allocated_amount>=0 AND allocated_amount<=amount AND (kind='charge' OR allocated_amount=0));
ALTER TABLE payments ADD CONSTRAINT payment_applied_amount CHECK(kind<>'charge' OR applied=(allocated_amount=amount));

CREATE FUNCTION guard_recorded_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.allocated_amount := CASE WHEN NEW.kind='charge' AND NEW.applied THEN NEW.amount ELSE 0 END;
 ELSE
  IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.provider_ref,NEW.amount,NEW.kind,NEW.attempt_id,NEW.offline_payment_id,NEW.review_reason,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.provider_ref,OLD.amount,OLD.kind,OLD.attempt_id,OLD.offline_payment_id,OLD.review_reason,OLD.created_at)
   OR NEW.allocated_amount<OLD.allocated_amount THEN
   RAISE EXCEPTION 'Recorded money and its original evidence cannot be rewritten' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_recorded_payment BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION guard_recorded_payment();
REVOKE DELETE ON payments FROM academy_app;

CREATE TABLE payment_reconciliations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 1000),
 amount integer NOT NULL CHECK(amount>=0), request_data jsonb NOT NULL,
 before_data jsonb NOT NULL, after_data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
ALTER TABLE payment_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_reconciliations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON payment_reconciliations TO academy_app;
CREATE TRIGGER staff_audit AFTER INSERT ON payment_reconciliations FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
CREATE INDEX reconciliation_order ON payment_reconciliations(tenant_id,order_id,created_at);
CREATE INDEX unapplied_charge_queue ON payments(tenant_id,order_id) WHERE kind='charge' AND NOT applied;
INSERT INTO schema_migrations(version) VALUES(19);
