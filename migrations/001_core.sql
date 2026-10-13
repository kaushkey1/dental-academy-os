-- Applied by a migration principal. The HTTP process must never use that principal.
CREATE ROLE academy_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE tenant_directory (
 id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('INR','USD')), locale text NOT NULL,
 timezone text NOT NULL, brand_color text NOT NULL DEFAULT '#174c43'
);
CREATE TABLE tenants (
 tenant_id uuid PRIMARY KEY REFERENCES tenant_directory(id),
 payment_provider text NOT NULL CHECK(payment_provider IN ('razorpay','stripe')),
 tax_config jsonb NOT NULL DEFAULT '{}', credit_config jsonb NOT NULL DEFAULT '{}',
 policies jsonb NOT NULL DEFAULT '{}', settings jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE staff (
 tenant_id uuid NOT NULL REFERENCES tenant_directory(id), id uuid NOT NULL,
 email text NOT NULL, name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','coordinator','marketing','faculty')),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,email)
);
CREATE TABLE contacts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL, mobile text NOT NULL,
 email text NOT NULL DEFAULT '', clinic text NOT NULL DEFAULT '',
 license_number text NOT NULL DEFAULT '', license_council text NOT NULL DEFAULT '',
 license_status text NOT NULL DEFAULT 'pending' CHECK(license_status IN ('pending','verified','rejected')),
 license_note text NOT NULL DEFAULT '', messaging_consent boolean NOT NULL DEFAULT false,
 consent_at timestamptz, consent_version text, first_touch jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,mobile)
);
CREATE TABLE programs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, title text NOT NULL, slug text NOT NULL,
 specialty text NOT NULL, description text NOT NULL DEFAULT '', objectives jsonb NOT NULL DEFAULT '[]',
 faculty jsonb NOT NULL DEFAULT '[]', credits numeric(6,2) NOT NULL DEFAULT 0 CHECK(credits>=0),
 credit_type text NOT NULL DEFAULT 'CDE', published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug)
);
CREATE TABLE offerings (
 tenant_id uuid NOT NULL, id uuid NOT NULL, program_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('workshop','course')), title text NOT NULL, slug text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','completed','cancelled')),
 starts_at timestamptz, ends_at timestamptz, venue text NOT NULL DEFAULT '',
 capacity integer CHECK(capacity>0), credits numeric(6,2) NOT NULL DEFAULT 0 CHECK(credits>=0),
 access_days integer CHECK(access_days>0), require_feedback boolean NOT NULL DEFAULT true,
 tax_rate_bps integer NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug),
 FOREIGN KEY(tenant_id,program_id) REFERENCES programs(tenant_id,id),
 CHECK ((kind='course' AND capacity IS NULL) OR (kind='workshop' AND capacity IS NOT NULL AND starts_at IS NOT NULL AND ends_at>starts_at))
);
CREATE TABLE sessions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL, title text NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, credits numeric(6,2) NOT NULL CHECK(credits>=0),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id), CHECK(ends_at>starts_at)
);
CREATE TABLE tickets (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL, name text NOT NULL,
 price integer NOT NULL CHECK(price>=0), deposit integer CHECK(deposit>0 AND deposit<=price),
 min_quantity integer NOT NULL DEFAULT 1 CHECK(min_quantity>0), allocation integer CHECK(allocation>0),
 sale_starts timestamptz, sale_ends timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
CREATE TABLE coupons (
 tenant_id uuid NOT NULL, id uuid NOT NULL, code text NOT NULL, offering_id uuid,
 percent integer NOT NULL CHECK(percent BETWEEN 1 AND 100), max_uses integer NOT NULL CHECK(max_uses>0),
 expires_at timestamptz NOT NULL, public boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code), FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
CREATE TABLE orders (
 tenant_id uuid NOT NULL, id uuid NOT NULL, contact_id uuid NOT NULL, offering_id uuid NOT NULL, ticket_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20), subtotal integer NOT NULL CHECK(subtotal>=0),
 discount integer NOT NULL DEFAULT 0 CHECK(discount>=0), tax integer NOT NULL DEFAULT 0 CHECK(tax>=0),
 tax_lines jsonb NOT NULL DEFAULT '[]', total integer NOT NULL CHECK(total>=0),
 due_now integer NOT NULL CHECK(due_now>0), paid integer NOT NULL DEFAULT 0 CHECK(paid>=0),
 refunded integer NOT NULL DEFAULT 0 CHECK(refunded>=0 AND refunded<=paid),
 currency text NOT NULL CHECK(currency IN ('INR','USD')), status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','partial','paid','expired','cancelled','refunded','review_required')),
 hold_expires_at timestamptz NOT NULL, coupon_id uuid, url_params jsonb NOT NULL DEFAULT '{}',
 billing jsonb NOT NULL DEFAULT '{}', provider_ref text, provider text NOT NULL,
 idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key), UNIQUE(tenant_id,provider_ref),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id,ticket_id) REFERENCES tickets(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,coupon_id) REFERENCES coupons(tenant_id,id),
 CHECK(total=subtotal-discount+tax), CHECK(due_now<=total), CHECK(paid<=total)
);
CREATE TABLE enrollments (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, offering_id uuid NOT NULL,
 contact_id uuid, seat_number integer NOT NULL, state text NOT NULL DEFAULT 'confirmed'
 CHECK(state IN ('confirmed','pre_course','attended','certified','cancelled','transferred','no_show','in_progress','completed','expired')),
 feedback_at timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,order_id,seat_number), UNIQUE(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id)
);
CREATE UNIQUE INDEX unique_active_enrollment ON enrollments(tenant_id,offering_id,contact_id) WHERE state NOT IN ('cancelled','transferred');
CREATE TABLE attendance (
 tenant_id uuid NOT NULL, offering_id uuid NOT NULL, enrollment_id uuid NOT NULL, session_id uuid NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(), checked_by text NOT NULL, method text NOT NULL CHECK(method IN ('qr','manual')),
 reason text NOT NULL DEFAULT '', PRIMARY KEY(tenant_id,enrollment_id,session_id),
 FOREIGN KEY(tenant_id,offering_id,enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id,session_id) REFERENCES sessions(tenant_id,offering_id,id)
);
CREATE TABLE lessons (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL, module_title text NOT NULL,
 title text NOT NULL, kind text NOT NULL CHECK(kind IN ('text','video','pdf')), position integer NOT NULL,
 content text NOT NULL DEFAULT '', asset_id text NOT NULL DEFAULT '', duration_seconds integer NOT NULL DEFAULT 0 CHECK(duration_seconds>=0),
 required boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
CREATE TABLE quizzes (
 tenant_id uuid NOT NULL, offering_id uuid NOT NULL, questions jsonb NOT NULL,
 pass_mark integer NOT NULL DEFAULT 70 CHECK(pass_mark BETWEEN 1 AND 100), max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts>0),
 PRIMARY KEY(tenant_id,offering_id), FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
CREATE TABLE progress (
 tenant_id uuid NOT NULL, offering_id uuid NOT NULL, enrollment_id uuid NOT NULL, lesson_id uuid NOT NULL,
 seconds_watched integer NOT NULL DEFAULT 0 CHECK(seconds_watched>=0), last_position integer NOT NULL DEFAULT 0,
 completed_at timestamptz, checkpoint_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,enrollment_id,lesson_id),
 FOREIGN KEY(tenant_id,offering_id,enrollment_id) REFERENCES enrollments(tenant_id,offering_id,id),
 FOREIGN KEY(tenant_id,offering_id,lesson_id) REFERENCES lessons(tenant_id,offering_id,id)
);
CREATE TABLE quiz_attempts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, enrollment_id uuid NOT NULL, score integer NOT NULL,
 passed boolean NOT NULL, answers jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,enrollment_id) REFERENCES enrollments(tenant_id,id)
);
CREATE TABLE certificates (
 tenant_id uuid NOT NULL, id uuid NOT NULL, enrollment_id uuid NOT NULL, serial text NOT NULL,
 verification_code text NOT NULL, snapshot jsonb NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, revocation_reason text, PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,serial), UNIQUE(verification_code), FOREIGN KEY(tenant_id,enrollment_id) REFERENCES enrollments(tenant_id,id)
);
CREATE UNIQUE INDEX one_active_certificate ON certificates(tenant_id,enrollment_id) WHERE revoked_at IS NULL;
CREATE TABLE leads (
 tenant_id uuid NOT NULL, id uuid NOT NULL, contact_id uuid NOT NULL, offering_id uuid,
 kind text NOT NULL CHECK(kind IN ('inquiry','abandoned','waitlist','manual')),
 stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','contacted','interested','payment_link_sent','won','lost')),
 owner_id uuid, source text NOT NULL DEFAULT 'Website', notes text NOT NULL DEFAULT '', lost_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES staff(tenant_id,id), CHECK(stage!='lost' OR length(lost_reason)>0)
);
CREATE TABLE seat_holds (
 tenant_id uuid NOT NULL, id uuid NOT NULL, offering_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0), reason text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,offering_id) REFERENCES offerings(tenant_id,id)
);
CREATE TABLE payments (
 tenant_id uuid NOT NULL, id uuid NOT NULL, order_id uuid NOT NULL, provider_ref text NOT NULL,
 amount integer NOT NULL CHECK(amount>0), kind text NOT NULL CHECK(kind IN ('charge','refund')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,provider_ref),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE webhook_events (
 tenant_id uuid NOT NULL, provider text NOT NULL, event_id text NOT NULL,
 payload jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,provider,event_id)
);
CREATE TABLE outbox (
 tenant_id uuid NOT NULL, id uuid NOT NULL, topic text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), last_error text, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE audit_log (
 tenant_id uuid NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY, actor_id text NOT NULL,
 action text NOT NULL, entity text NOT NULL, record_id text, before_data jsonb, after_data jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE auth_challenges (
 tenant_id uuid NOT NULL, id uuid NOT NULL, identifier text NOT NULL, kind text NOT NULL CHECK(kind IN ('staff','learner')),
 code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION audit_staff_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := current_setting('app.actor_id',true); item jsonb;
BEGIN
 IF coalesce(actor,'')<>'' AND actor NOT LIKE 'learner:%' AND actor<>'system' THEN
  item := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  INSERT INTO audit_log(tenant_id,actor_id,action,entity,record_id,before_data,after_data)
  VALUES((item->>'tenant_id')::uuid,actor,TG_OP,TG_TABLE_NAME,item->>'id',
   CASE WHEN TG_OP!='INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP!='DELETE' THEN to_jsonb(NEW) END);
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO academy_app',t);
  IF t NOT IN ('audit_log','auth_challenges','webhook_events','outbox') THEN
   EXECUTE format('CREATE TRIGGER staff_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_staff_write()',t);
  END IF;
 END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO academy_app;
GRANT SELECT ON tenant_directory TO academy_app;
REVOKE UPDATE,DELETE ON audit_log FROM academy_app;
CREATE INDEX order_capacity ON orders(tenant_id,offering_id,status,hold_expires_at);
CREATE INDEX enrollment_roster ON enrollments(tenant_id,offering_id,state);
CREATE INDEX lead_queue ON leads(tenant_id,stage,created_at);
CREATE INDEX pending_events ON outbox(tenant_id,available_at) WHERE delivered_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(1);
