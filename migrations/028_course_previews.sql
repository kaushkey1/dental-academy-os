ALTER TABLE lessons ADD COLUMN free_preview boolean NOT NULL DEFAULT false;
ALTER TABLE offerings ADD COLUMN preview_revision integer NOT NULL DEFAULT 1 CHECK (preview_revision > 0);
INSERT INTO schema_migrations(version) VALUES(28);
