ALTER TABLE offline_payments ADD CONSTRAINT offline_decision_evidence CHECK (
 (status IN ('approved','rejected','withdrawn') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND decision_reason IS NOT NULL AND length(decision_reason)>=5)
 OR (status IN ('draft','pending') AND reviewed_at IS NULL AND reviewed_by IS NULL AND decision_reason IS NULL)
);
CREATE FUNCTION guard_offline_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
 RAISE EXCEPTION 'Submission evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_offline_submission BEFORE UPDATE ON offline_payments FOR EACH ROW EXECUTE FUNCTION guard_offline_submission();
INSERT INTO schema_migrations(version) VALUES(16);
