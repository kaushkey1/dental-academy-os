ALTER TABLE lessons ADD COLUMN content_format text NOT NULL DEFAULT 'plain' CHECK(content_format IN ('plain','rich-text-v1'));
ALTER TABLE lessons ADD COLUMN rich_content jsonb;
ALTER TABLE lessons ADD CONSTRAINT rich_lesson_shape CHECK(
 (content_format='plain' AND rich_content IS NULL) OR
 (content_format='rich-text-v1' AND kind='text' AND rich_content IS NOT NULL AND jsonb_typeof(rich_content)='object' AND (rich_content->>'type') IS NOT DISTINCT FROM 'doc')
);
INSERT INTO schema_migrations(version) VALUES(11);
