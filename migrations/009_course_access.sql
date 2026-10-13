ALTER TABLE enrollments ALTER COLUMN order_id DROP NOT NULL;
CREATE FUNCTION validate_granted_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.order_id IS NULL AND NOT EXISTS(SELECT 1 FROM offerings WHERE tenant_id=NEW.tenant_id AND id=NEW.offering_id AND kind='course') THEN
  RAISE EXCEPTION 'Only course access can exist without an order';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_granted_enrollment BEFORE INSERT OR UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION validate_granted_enrollment();

CREATE TABLE workshop_courses (
 tenant_id uuid NOT NULL, id uuid NOT NULL, workshop_id uuid NOT NULL, course_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('prework','recording')), access_days integer CHECK(access_days BETWEEN 1 AND 36500),
 active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,workshop_id,course_id,purpose), UNIQUE(tenant_id,workshop_id,course_id,id),
 FOREIGN KEY(tenant_id,workshop_id) REFERENCES offerings(tenant_id,id),
 FOREIGN KEY(tenant_id,course_id) REFERENCES offerings(tenant_id,id), CHECK(workshop_id<>course_id)
);
CREATE TABLE course_access_sources (
 tenant_id uuid NOT NULL, id uuid NOT NULL, course_id uuid NOT NULL, enrollment_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('manual','workshop','purchase')),
 workshop_id uuid, source_enrollment_id uuid, attachment_id uuid, order_id uuid,
 starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 reason text NOT NULL, request_data jsonb NOT NULL DEFAULT '{}',
 granted_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, revoked_by text, revoke_reason text,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,attachment_id,source_enrollment_id), UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,course_id,enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,workshop_id,course_id,attachment_id) REFERENCES workshop_courses(tenant_id,workshop_id,course_id,id),
 FOREIGN KEY(tenant_id,workshop_id,source_enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CHECK(expires_at IS NULL OR expires_at>starts_at),
 CHECK((source='workshop' AND workshop_id IS NOT NULL AND source_enrollment_id IS NOT NULL AND attachment_id IS NOT NULL AND order_id IS NULL)
 OR (source='manual' AND workshop_id IS NULL AND source_enrollment_id IS NULL AND attachment_id IS NULL AND order_id IS NULL)
 OR (source='purchase' AND workshop_id IS NULL AND source_enrollment_id IS NULL AND attachment_id IS NULL AND order_id IS NOT NULL))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workshop_courses','course_access_sources'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO academy_app',t);
  EXECUTE format('CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION audit_staff_write()',t);
 END LOOP;
END $$;
CREATE INDEX course_access_lookup ON course_access_sources(tenant_id,enrollment_id);
INSERT INTO schema_migrations(version) VALUES(9);
