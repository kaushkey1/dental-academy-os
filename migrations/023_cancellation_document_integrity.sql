ALTER TABLE billing_documents ADD CONSTRAINT cancellation_document_shape CHECK(
 (kind IN ('credit_note','cancellation_statement') AND cancellation_id IS NOT NULL AND payment_id IS NULL AND (kind<>'credit_note' OR original_document_id IS NOT NULL))
 OR (kind NOT IN ('credit_note','cancellation_statement') AND cancellation_id IS NULL AND original_document_id IS NULL)
);
INSERT INTO schema_migrations(version) VALUES(23);
