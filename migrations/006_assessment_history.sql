ALTER TABLE quizzes ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE quizzes ADD COLUMN change_reason text NOT NULL DEFAULT 'Initial post-test';
CREATE TABLE quiz_versions (
 tenant_id uuid NOT NULL, offering_id uuid NOT NULL, revision integer NOT NULL,
 questions jsonb NOT NULL, pass_mark integer NOT NULL CHECK(pass_mark BETWEEN 1 AND 100),
 max_attempts integer NOT NULL CHECK(max_attempts>0), change_reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
 PRIMARY KEY(tenant_id,offering_id,revision),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
INSERT INTO quiz_versions(tenant_id,offering_id,revision,questions,pass_mark,max_attempts,change_reason,created_by)
 SELECT tenant_id,offering_id,revision,questions,pass_mark,max_attempts,'Current configuration imported; earlier attempt versions are unknown','system' FROM quizzes;
ALTER TABLE quiz_attempts ADD COLUMN offering_id uuid;
UPDATE quiz_attempts a SET offering_id=e.offering_id FROM enrollments e WHERE e.tenant_id=a.tenant_id AND e.id=a.enrollment_id;
ALTER TABLE quiz_attempts ALTER COLUMN offering_id SET NOT NULL;
ALTER TABLE quiz_attempts ADD COLUMN quiz_revision integer;
ALTER TABLE quiz_attempts ADD COLUMN submission_id uuid;
ALTER TABLE quiz_attempts ALTER COLUMN score TYPE numeric(5,2);
ALTER TABLE quiz_attempts ADD CONSTRAINT attempt_offering FOREIGN KEY(tenant_id,offering_id,enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id);
ALTER TABLE quiz_attempts ADD CONSTRAINT attempt_version FOREIGN KEY(tenant_id,offering_id,quiz_revision) REFERENCES quiz_versions(tenant_id,offering_id,revision);
CREATE UNIQUE INDEX unique_quiz_submission ON quiz_attempts(tenant_id,enrollment_id,submission_id) WHERE submission_id IS NOT NULL;
CREATE TABLE quiz_retake_requests (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL, enrollment_id uuid NOT NULL,
 reason text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
 additional_attempts integer NOT NULL DEFAULT 0 CHECK(additional_attempts BETWEEN 0 AND 5),
 review_note text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id,enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,reviewed_by) REFERENCES staff(tenant_id,id),
 CHECK((status='approved' AND additional_attempts>0 AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(review_note)>=5)
 OR (status='declined' AND additional_attempts=0 AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(review_note)>=5)
 OR (status='pending' AND additional_attempts=0 AND reviewed_by IS NULL AND reviewed_at IS NULL))
);
CREATE UNIQUE INDEX one_pending_retake ON quiz_retake_requests(tenant_id,enrollment_id) WHERE status='pending';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['quiz_versions','quiz_retake_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO academy_app',t);
  EXECUTE format('CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_staff_write()',t);
 END LOOP;
END $$;
CREATE FUNCTION preserve_assessment_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Assessment history is immutable';
END $$;
CREATE TRIGGER immutable_quiz_version BEFORE UPDATE OR DELETE ON quiz_versions FOR EACH ROW EXECUTE FUNCTION preserve_assessment_record();
CREATE TRIGGER immutable_quiz_attempt BEFORE UPDATE OR DELETE ON quiz_attempts FOR EACH ROW EXECUTE FUNCTION preserve_assessment_record();
CREATE FUNCTION record_quiz_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Quiz revisions must increase by one'; END IF;
 INSERT INTO quiz_versions(tenant_id,offering_id,revision,questions,pass_mark,max_attempts,change_reason,created_by)
 VALUES(NEW.tenant_id,NEW.offering_id,NEW.revision,NEW.questions,NEW.pass_mark,NEW.max_attempts,NEW.change_reason,coalesce(nullif(current_setting('app.actor_id',true),''),'system'));
 RETURN NEW;
END $$;
CREATE TRIGGER quiz_version_snapshot AFTER INSERT OR UPDATE ON quizzes FOR EACH ROW EXECUTE FUNCTION record_quiz_version();
INSERT INTO schema_migrations(version) VALUES(6);
