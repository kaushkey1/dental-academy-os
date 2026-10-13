# GCP deployment preparation

Nothing has been deployed and no cloud resources have been purchased. Hosting remains
deferred per the user. These are prepared deployment inputs, not a successful deployment.

## Proposed topology

- Cloud Run: stateless web/API container, HTTPS at the ingress, PORT=8080.
- Cloud SQL PostgreSQL: shared database with forced tenant RLS, backups and PITR.
- Secret Manager: DB/session/provider credentials with a least-privilege runtime identity.
- Cloud Storage: private document and upload objects (integration not implemented).
- Cloud Tasks + Cloud Scheduler: retryable delivery/scheduled checks (not implemented).
- Artifact Registry and Cloud Build: immutable container images.
- Cloud Logging, alerting and error tracking: structured events and operational monitoring.

Region, data residency, availability tier, domain strategy and budget are undecided.
The example build region is a replaceable default, not a hosting commitment.

## Runtime vs migration database roles

Run migrations once as a deployment job with DATABASE_ADMIN_URL. The image includes:

```sh
node dist-server/scripts/migrate.js
```

The migration creates the restricted `academy_app` NOLOGIN/NOBYPASSRLS role. Provision
an application login with no superuser, role-creation or BYPASSRLS rights and grant it
membership in academy_app. Store that login's connection URL as DATABASE_URL. Never
supply migration credentials to the HTTP process. Runtime queries must be able to
SET LOCAL ROLE academy_app. Production startup rejects superuser/BYPASSRLS logins.

The runtime principal also needs schema USAGE. Use a Cloud SQL connector/proxy or Unix
socket connection and keep database transport private. No plaintext production password
is included in these files. Validate permissions with the production-role isolation tests.

## Build and release

```sh
npm ci
npm run build
npm test
docker build -t dental-academy-os:local .
```

The Docker build was not executed in the initial environment. Test image startup,
health, SIGTERM shutdown and read-only runtime behavior before deployment. The sample
`infra/cloudbuild.yaml` only builds/pushes. `infra/cloud-run.template.yaml` contains
REPLACE_* placeholders and is deliberately not deployable as-is.

Run all [release gates](RELEASE.md) before switching real checkout traffic. Start with
a complete staging dry-run for each academy, then a monitored real booking. Do not
seed sample data in production. The provisioning/import workflow must create real tenants
and memberships separately; that onboarding tooling is still pending.

## Operations before cutover

Prove backup restoration, webhook retry recovery, migration rollback/forward recovery,
provider reconciliation, delivery failure alerts and on-call ownership. Confirm worker
idempotency, pool limits versus max instances, secret rotation, domain TLS and lifecycle
of academy exports/deletions. Perform low-bandwidth mobile, keyboard and screen-reader
checks. Keep old WordPress orders read-only until migration is reconciled.
