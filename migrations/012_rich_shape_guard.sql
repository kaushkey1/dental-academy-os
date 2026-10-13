-- CHECK accepts NULL; explicitly reject a JSON object without a document type.
-- Separate migration also upgrades development databases which applied version 11.
ALTER TABLE lessons DROP CONSTRAINT rich_lesson_shape;
ALTER TABLE lessons ADD CONSTRAINT rich_lesson_shape CHECK(
 (content_format='plain' AND rich_content IS NULL) OR
 (content_format='rich-text-v1' AND kind='text' AND rich_content IS NOT NULL AND jsonb_typeof(rich_content)='object' AND (rich_content->>'type') IS NOT DISTINCT FROM 'doc')
);
INSERT INTO schema_migrations(version) VALUES(12);
