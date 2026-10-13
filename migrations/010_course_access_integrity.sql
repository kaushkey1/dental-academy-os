-- One course has one unlock rule within a workshop: its lessons cannot be both locked and already open.
ALTER TABLE workshop_courses ADD CONSTRAINT one_course_per_workshop UNIQUE(tenant_id,workshop_id,course_id);
ALTER TABLE orders ADD CONSTRAINT order_offering_reference UNIQUE(tenant_id,offering_id,id);
ALTER TABLE course_access_sources ADD CONSTRAINT purchase_course_reference FOREIGN KEY(tenant_id,course_id,order_id) REFERENCES orders(tenant_id,offering_id,id);
INSERT INTO schema_migrations(version) VALUES(10);
