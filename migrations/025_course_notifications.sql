ALTER TABLE contacts ADD COLUMN course_reminders_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE learner_notifications (
 tenant_id uuid NOT NULL, id uuid NOT NULL, contact_id uuid NOT NULL, enrollment_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('course_ready','access_changed','access_ended','access_scheduled','course_expiring','certificate_ready')),
 title text NOT NULL, body text NOT NULL, dedupe_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, superseded_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,dedupe_key),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,enrollment_id) REFERENCES enrollments(tenant_id,id)
);
CREATE INDEX learner_notification_inbox ON learner_notifications(tenant_id,contact_id,created_at DESC,id DESC);

CREATE TABLE course_notification_state (
 tenant_id uuid NOT NULL, enrollment_id uuid NOT NULL, snapshot jsonb NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 0, next_check_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text,
 PRIMARY KEY(tenant_id,enrollment_id),
 FOREIGN KEY(tenant_id,enrollment_id) REFERENCES enrollments(tenant_id,id)
);
CREATE INDEX course_notification_due ON course_notification_state(tenant_id,next_check_at);

-- A consumer receipt, not the shared outbox's delivery marker. Other consumers keep their events.
CREATE TABLE course_notification_events (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, processed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES outbox(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['learner_notifications','course_notification_state','course_notification_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO academy_app',t);
 END LOOP;
END $$;
CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON learner_notifications FOR EACH ROW EXECUTE FUNCTION audit_staff_write();
INSERT INTO schema_migrations(version) VALUES(25);
