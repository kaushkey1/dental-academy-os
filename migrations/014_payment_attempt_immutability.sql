CREATE FUNCTION guard_payment_request_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.id,NEW.order_id,NEW.purpose,NEW.provider,NEW.amount,NEW.currency,NEW.request,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.order_id,OLD.purpose,OLD.provider,OLD.amount,OLD.currency,OLD.request,OLD.expires_at,OLD.created_at) THEN
  RAISE EXCEPTION 'A saved payment request cannot change its identity, amount or request snapshot' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_payment_request BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_payment_request_snapshot();
INSERT INTO schema_migrations(version) VALUES(14);
