ALTER TABLE lessons ADD COLUMN archived_at timestamptz;
ALTER TABLE lessons ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE offerings ADD COLUMN curriculum_revision integer NOT NULL DEFAULT 1 CHECK(curriculum_revision > 0);
CREATE INDEX active_course_lessons ON lessons(tenant_id,offering_id,position) WHERE archived_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(5);
