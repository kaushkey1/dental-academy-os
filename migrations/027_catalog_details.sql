ALTER TABLE programs ADD COLUMN catalog_details jsonb;
ALTER TABLE offerings ADD COLUMN catalog_details jsonb;
ALTER TABLE programs ADD CONSTRAINT program_catalog_details_shape CHECK (
  catalog_details IS NULL OR (
    jsonb_typeof(catalog_details)='object' AND
    (catalog_details->>'type') IS NOT DISTINCT FROM 'doc'
  )
);
ALTER TABLE offerings ADD CONSTRAINT offering_catalog_details_shape CHECK (
  catalog_details IS NULL OR (
    jsonb_typeof(catalog_details)='object' AND
    (catalog_details->>'type') IS NOT DISTINCT FROM 'doc'
  )
);
INSERT INTO schema_migrations(version) VALUES(27);
