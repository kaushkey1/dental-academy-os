# Netlify demonstration deployment

The user requested GitHub + Netlify hosting and a copy of the local data for demos on
October 14, 2026. This is an isolated, persistent demonstration environment. The full
October 31 release contract remains open in RELEASE.md.

- Source: https://github.com/kaushkey1/dental-academy-os (private, main).
- Site: https://dental-academy-os-kaushkey.netlify.app
- Project: https://app.netlify.com/projects/dental-academy-os-kaushkey
- Public sharing approved October 14: the production URL opens without a Netlify login.
  Non-production contexts retain Netlify team protection. Role workspaces still require
  the host-shared demo access code.
- Build: npm run build; static files in dist; Express runs in the api function.
- PostgreSQL provides transactions, forced tenant RLS and persistent data. Use a
  dedicated LOGIN role granted academy_app, without superuser/BYPASSRLS/CREATEROLE.
- Netlify Blobs holds private content-addressed documents; reads go through authenticated
  API permissions and SHA-256 verification. GCS remains supported for a future GCP deployment.
- The course-updates function runs every 15 minutes. Delivery remains inside the portal.
- main push webhooks trigger continuous deployment. Branch/PR builds are disabled until
  isolated database credentials and data are configured for those environments.

## Runtime settings

Configure APP_MODE=production, NODE_ENV=production, PUBLIC_ORIGIN, a random SESSION_SECRET,
the restricted DATABASE_URL, and MEDIA_STORAGE=netlify in Netlify's environment manager.
Never use VITE_ prefixes for secrets or place them in netlify.toml. Migration credentials
must never enter the function runtime or repository.

For this separate demo only, enable DEMO_MODE=true, set a random DEMO_ACCESS_CODE (at least
20 characters), and DEMO_IDENTITIES_JSON mapping academy slugs and roles to explicit
existing demo identity UUIDs. All five roles use the same host-shared access code. Normal
OTP requests are blocked; the code is never returned by an API. Failed attempts are
persistently rate limited; identities must remain active and match the selected role.
Changes made by reviewers are persistent and shared. Do not enter real patient/customer data.

No real payment, email or SMS credentials belong in this demo. Configuration validation
rejects these credentials in demo mode. Imported payment records are demonstration history,
not confirmation of live transfers. Video requires a separately configured Mux account.

## Local data copy

Stop the development database process before taking a filesystem snapshot; reopen the
snapshot separately and restart local development. Export data as PostgreSQL JSON records,
omitting auth challenges. Store all copies under ignored .netlify with restricted file modes.
Import into a new empty database only. Preserve IDs, timestamps, progress and audit history;
verify table counts, foreign keys, tenant boundaries and file hashes. Map local storage
providers to netlify, rotate public integration keys, and never import local session secrets.
Add missing demonstration role accounts and faculty assignments explicitly after import.
Never run sample seeding automatically on deployment or every server start.

The Netlify production database is read-only for personal access tokens by default.
Temporary full access requires owner approval. Disable that permission after setup.

## Limits and release work

Buffered Netlify Functions impose a smaller upload ceiling than the long-running GCP server.
This host limits new PDF/proof uploads to 4 MB, reflected in the UI and server validation.
Existing larger files need a streaming/download design before importing them here.
The current local documents are below that limit. Video uploads go directly to Mux.

Production launch needs a separate clean database and fresh session secret, DEMO_MODE off,
real staff provisioning, approved catalog/legal content, provider setup and release gates.
Review the Free plan's credit/storage limits before demos; no paid upgrade is configured.
Schema changes require an explicit migration using an operator connection before code that
depends on them is deployed. Builds never run migrations or seed data automatically.

## Pending catalog details deployment — October 17

The Netlify dashboard reports the team credit limit exceeded and all projects/deploys
paused. The account owner must restore hosting access before this update can be deployed.
The catalog details feature requires migration 027, which adds optional JSONB columns to
programs and offerings. Apply it using a temporary, approved migration connection before
merging the feature branch into main; never add the migration credential to runtime.
Disable temporary database owner access after migration, then merge/deploy and verify
public detail responses and editor persistence for both academies. Existing plain
descriptions require no data conversion and the previous app remains compatible with the
additive migration. The review samples created locally are not copied to the hosted demo.

### October 19 follow-up: public course previews

This branch also requires migration **028** before deployment. It adds `lessons.free_preview`
(default false) and `offerings.preview_revision`; it does not publish any existing lesson. Apply
027 and 028 with the migration owner credentials before switching the server version. Do not
use runtime/read-only credentials for schema changes. Deployment remains pending the hosting
credit/access block noted above; this change has only been run locally.

After deployment, configure allowed website origins, verify the new curriculum API, then select
preview lessons in the course builder. Mux signing and playback-domain restrictions must include
the public website before testing actual video playback. PDF preview bytes use the existing
private media storage adapter. The simplified finance interface does not remove stored tax,
invoice or refund records or change server accounting.
