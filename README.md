# Dental Academy OS

An academy operations platform for Icode India and Skillodontics, from booking through
certificate, with self-paced online courses. **Target: October 31, 2026.**

This is the first implemented and tested production-oriented increment, **not a finished
Phase 1 release**. The full agreed scope and outstanding work are tracked in
[the release matrix](docs/RELEASE.md). Hosting has not been provisioned or deployed.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The API runs on port 3001. Development automatically creates
an embedded PostgreSQL database in `.local/database` and seeds clearly marked sample
records for both academies. No Docker or external account is needed for local development.

- Staff: choose either academy, use `admin@example.com`, then enter the displayed local code.
- Icode sample online learner: visit `/learn/icode`, use `+919000000300`.
- Icode sample workshop learner: use `+919000000001`.
- Sign out before switching between staff, learners or academies.
- The development code is never returned when `APP_MODE=production`.
- Sample certificates are explicitly marked as not valid for professional credit.
- No local payment simulation is presented as a successful real payment.

## Implemented workflows

- OTP sessions, role checks, database tenant isolation and append-only staff audit history.
- Program creation, dated workshops, price tickets, roster, capacity reservations and holds.
- India/US payment adapters with signature checking, raw event inbox and capture deduplication.
- Professional profiles and manual license verification.
- Learner checkout with deposits, coupons, captured URL parameters and group-seat assignment.
- Leads, follow-up notes and stages; public inquiry/waitlist capture.
- Session attendance, certificate prerequisites, PDF creation, public verification and revocation.
- Text/video course builder, question editor, learner course access, progress and server-scored quizzes.
- Order CSV export with URL parameters and spreadsheet formula protection.
- Academy settings website setup: tenant API keys, allowed origins, copyable examples, developer guide and connection test.
- Versioned public catalog reads, hosted checkout links and website inquiry/waitlist capture.

Provider adapters are implemented but have **not** been exercised against real provider
accounts. Invoice issuance, refunds and transfers, the delivery worker and several other
Phase 1 requirements are still open. See [RELEASE.md](docs/RELEASE.md), not this summary,
for the acceptance boundary.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Tests use actual embedded PostgreSQL (PGlite), not an in-memory JavaScript data store.
The HTTP suite signs in through OTP and exercises real routes. It opens an ephemeral
loopback listener. Concurrency semantics still require a separate multi-connection test
against server PostgreSQL before release; PGlite serializes local transactions.

Browser/visual QA was not completed in the initial build environment because the bundled
browser automation module was missing. Do not treat an open preview or a successful
build as a passed browser acceptance test.

## Production target

React + TypeScript interface, Express/TypeScript API, PostgreSQL with RLS, and a stateless
Node container. The API supports `DATABASE_URL` for Cloud SQL. Production refuses an
embedded database, missing session secret, non-HTTPS origin or an RLS-bypassing DB role.

See [architecture](docs/ARCHITECTURE.md), [integrations](docs/INTEGRATIONS.md), and
[GCP deployment](docs/GCP.md). Provider accounts and real academy data are not included.
