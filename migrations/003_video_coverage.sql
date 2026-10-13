ALTER TABLE progress ADD COLUMN covered_ranges jsonb NOT NULL DEFAULT '[]';
INSERT INTO schema_migrations(version) VALUES(3);
