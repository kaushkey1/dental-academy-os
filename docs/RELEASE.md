# October 31 release contract

Updated: October 14, 2026. **Status: implementation in progress; not ready for live use.**

User decisions: BOTH academies, INCLUDING complete online courses. Target is October 31,
2026 (Asia/Kolkata planning date). Hosting comes last, probably GCP. A working prototype
is not the delivery target. The full Phase 1 PRD remains the acceptance contract.

The original PRD estimates 15–21 weeks with 3–4 engineers plus a designer. October 31
is an aggressive target, not a verified feasibility commitment. Use evidence and explicit
release gates; do not silently reduce scope or label open work as complete.

## Acceptance matrix

| Area                | Implemented and locally tested                                                                                                                                                                                                                                                           | Required before finished release                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenancy             | Tenant-scoped SQL, forced RLS, composite foreign keys, two configuration-driven sample academies                                                                                                                                                                                         | Production-role server Postgres tests; real onboarding; custom domains/TLS                                                                                                                                                                                               |
| Roles               | Admin team management; capability-driven staff navigation; faculty assignments/own-run access; marketing read-only leads/results; immediate membership disable                                                                                                                           | Platform admin; staff second factor; per-session revocation and session inventory                                                                                                                                                                                        |
| Catalog             | Program/offering edit and archive/restore; revision guards; academy-timezone schedules; capacity/credit safeguards; ticket tiers/deposits/allocations; scoped public/private coupons                                                                                                     | Cancellation/refund workflow; schedule-change delivery; corrections after attendance/certification; approved catalog/prices/credits                                                                                                                                      |
| Checkout            | Mobile OTP session; profile/license capture; held inventory; coupon/deposit calculation; URL params on order; group assignment                                                                                                                                                           | First-touch and abandoned funnel timing; returning-profile refinements; reviewed tax/place-of-supply calculation; policy acceptance; optional post-payment redirect                                                                                                      |
| Payments            | Durable initial/balance requests; uncertain-create recovery; buyer/staff history; deposit deadlines; provider capture and review ledger; signed webhook inbox/deduplication; private offline proofs/admin approval; received-money resolution queue/allocations; approved excess returns | Real provider staging; automatic cutoff reminders/release; provider link expiry at hold deadline; EMI/minimum amount validation; daily provider reconciliation; returns for unconfirmed/applied payments; online shortfall collection; real offline-operation acceptance |
| Tax & invoices      | Buyer billing capture; legal issuer settings; annual tenant numbering; immutable invoices/receipts; private PDF preview/download; missing-details recovery queue; sample GST templates                                                                                                   | Live GST place-of-supply workflow (hard gated); reviewed regional policies; advance vouchers; exempt/export/UTGST handling; IRN if required; credit notes; historical import; multilingual fonts; accountant approval                                                    |
| Refunds & transfers | Versioned accepted cancellation policies; whole-booking request/admin decision; applied/excess refund ledger; private cancellation statements and original-invoice-linked credit notes; durable provider attempts and verified offline returns                                           | Real provider/accountant review; manual-provider reconciliation; retry worker; learner/run transfers; price differences; partial-seat and bulk cancellation                                                                                                              |
| Leads               | Staff entry, notes/stages/lost reasons; public inquiry and waitlist capture                                                                                                                                                                                                              | Owner assignment/filtering; abandoned recovery; coordinator discounts/payment links; full timeline; waitlist offer rotation                                                                                                                                              |
| Seat management     | Transactional reservations; TTL-aware availability; explicit hold API                                                                                                                                                                                                                    | Hold UI/release; multi-connection load test; no-show and deposit-cutoff jobs                                                                                                                                                                                             |
| Attendance          | Per-session manual check-in; assigned faculty access; final-session attendance state; idempotent events; reason/actor audit                                                                                                                                                              | QR tickets/scanner; offline queue/conflict sync; learner self check-in; bulk actions; partial-credit rules                                                                                                                                                               |
| Certificates        | Eligibility gating; PDF; random public verification; snapshot; revocation; completion triggers                                                                                                                                                                                           | Academy templates/logos/signatures; framework-specific required fields; approved accreditation config; partial credits; reissue/correction; complete PDF QA                                                                                                              |
| Courses             | Rich-text/PDF/video authoring; private media and reading resume; recoverable lesson drafts/autosave and publication checks; versioned assessments/retakes; grants and workshop inclusions; complete photography review course with 12 lessons, workbook and capstone in both academies   | Academy-approved content/faculty/accreditation; live GCS/Mux checks; legacy imports; external grant/expiry delivery; mobile video and large-document performance                                                                                                         |
| Learner portal      | Workshops/courses; course player; buyer payment history/balance links/offline review status; group-seat assignment; feedback; certificate download                                                                                                                                       | QR tickets; cancellation/transfer requests; profile editing; payment list pagination; complete accessible/mobile UX                                                                                                                                                      |
| Notifications       | Durable domain-event outbox; course portal inbox with read history, expiry preferences, event consumer, scheduled access checks and retry backoff                                                                                                                                        | BSP choice; WhatsApp template approvals; external delivery/receipts; general journey schedules; email invoice/certificate attachments; deployed scheduler/alerts                                                                                                         |
| Public API          | Admin website setup; tenant keys and rotation; origin allowlist/CORS; v1 catalog, checkout and enquiries; copyable examples, guide and connection test                                                                                                                                   | Dedicated pricing/content resources; pagination; shared per-key rate limiting/cache; webhook subscriptions/delivery; WordPress widgets; deployed-site acceptance                                                                                                         |
| Reporting           | Admin totals; marketing per-offering receipts/refunds; order CSV with URL columns; license/lead queues; course learning progress                                                                                                                                                         | Full date/run/program reports; funnel/recovery metrics; risk thresholds; platform reports; all-entity export; pagination                                                                                                                                                 |
| Privacy             | Consent record; tenant RLS; no patient entities; safe CSV                                                                                                                                                                                                                                | Academy-approved notices/retention; export/deletion jobs; data inventory; recovery/legal review                                                                                                                                                                          |
| Infrastructure      | Production env guard; stateless Node build; Docker/GCP templates; CI definition                                                                                                                                                                                                          | Docker execution; GCP provisioning; secrets; storage/jobs; monitoring; backups/restore; custom domains; load/performance tests                                                                                                                                           |
| Migration           | None yet                                                                                                                                                                                                                                                                                 | Icode catalog; LearnDash program/run dedupe; learner/course access import; historical certificate import; counts and reconciliation; old URL redirects                                                                                                                   |
| QA                  | 213 invariant/authenticated HTTP/provider-contract tests; production build; targeted desktop/mobile browser checks                                                                                                                                                                       | Browser visual/keyboard/responsive checks; real Postgres concurrency; real provider staging; security review; both-academy acceptance sign-off                                                                                                                           |

## Next implementation slices

1. Prioritize the complete course experience per the latest user direction. The photography
   course is installed for review and persistent drafts/publication are implemented.
   Finish academy editorial/faculty decisions and keep reviewing useful learner outcomes,
   including course migration. Course portal access/expiry updates are implemented; external
   delivery and provider checks await setup and staging.
2. Payment work is parked at the current tested checkpoint at the user's request. Resume
   remaining money/provider/tax requirements only when needed for release acceptance or
   explicitly reprioritized. No further payment micro-refinements are the immediate task.
3. Extend the course event worker to other scheduled journey rules and WhatsApp/email adapters,
   waitlist offers and audit/message timelines.
4. Finish QR/offline attendance, configurable certificates, roles, public integrations,
   reporting and data ownership controls.
5. Build and reconcile import tools for both academies. Finish all onboarding settings
   and approved policies/content. Run full dry-runs, mobile/accessibility and load tests.
6. Provision GCP only after the hosting decision; rehearse restore and deploy/cutover.

## Working calendar (targets, not completion claims)

- Oct 11–15: tenancy/auth/catalog/course authoring and integration account onboarding.
- Oct 16–20: checkout, full money lifecycle, invoices and notification delivery.
- Oct 21–24: attendance/certificates, public API/widgets, reporting and migration tools.
- Oct 25–28: both-tenant staging migration, provider tests, end-to-end acceptance and fixes.
- Oct 29–30: load/security/accessibility checks, backup/rollback rehearsal and cutover readiness.
- Oct 31: launch only after release gates pass. If gates fail, communicate the specific gap;
  do not accept money through an unverified workflow to preserve a date.

## Release gates

- [ ] Every Phase 1 acceptance row above complete or explicitly changed by the user.
- [ ] Both academies approve catalog, prices, policies, legal/tax/credit fields and branding.
- [ ] Full and deposit booking through real provider sandbox, invoice and notifications.
- [ ] Balance settlement, refund, credit note, transfer and reconciliation proven.
- [ ] Two simultaneous buyers of the last seat tested with independent Postgres connections.
- [ ] Cross-tenant API/RLS tests under actual deployment credentials.
- [ ] Workshop and course completion produce correct framework-approved PDFs and verify publicly.
- [ ] Video upload/playback, access expiry and lesson/quiz resume verified on mobile.
- [ ] QR attendance works offline and syncs idempotently.
- [ ] Approved WhatsApp templates, opt-out and retry/error handling verified.
- [ ] Legacy counts and access reconciled; redirects verified.
- [ ] Browser, accessibility, performance and security review complete.
- [ ] GCP restore, migration recovery, alerts, on-call owner and rollback proven.
- [ ] No sample data, local OTP disclosure or disconnected services in live environment.

## Verification evidence

The current 213 tests cover forced RLS, foreign-tenant references, local competing
reservations, idempotent captures, amount checks, certificate prerequisites, append-only
staff audit, role restrictions, tax rounding, signature replay windows, CSV safety, OTP
single use/attempt accounting, authenticated catalog creation, learner ownership,
server-hidden quiz answers, course-to-certificate flow, revocation, group-seat ownership,
public API keys, license-change invalidation, unique video coverage, durable webhook failure recovery,
team administration, faculty assignments/revocation, both-tenant role data boundaries, session attendance,
lesson editing/reordering/archiving/restoration, stale writes, replacement-video progress reset,
course learner visibility, completion requirements and preservation of issued certificates. Subsequent test output is the current
source of truth; update this section when the suite changes.

No live provider call, GCP deploy, migration of real customer data, or full both-academy
acceptance has been completed. Targeted browser checks are recorded below; they do not
close the full browser, accessibility or production release gates.

October 11 theme update: replaced green branding with cobalt blue and cool neutral
surfaces across staff and learner interfaces. Production build passed; primary buttons,
selected navigation, muted text on blue surfaces and positive badges each exceed 4.5:1
text contrast. The live Programs screen was visually checked using the in-app browser.
This focused appearance check does not complete the browser acceptance gate above.

October 11 website integration update: admin-only Academy settings now provides each
academy’s API URL, publishable key, portal URL, exact website-origin allowlist, key
creation/replacement, seven endpoint examples, downloadable developer guide and a live
read-only connection test. Existing tenants without keys can enable the API without
reseeding. Both local sample academies now have working, separate publishable keys.

Ten additional HTTP tests cover admin/learner/staff permissions, tenant isolation,
origin validation and CORS preflight, unchanged staff write protection, enquiry
persistence, unpublished content, executing generated examples, key invalidation,
legacy key creation and browser-readable throttling. Production build and all 35 tests
passed. Icode’s in-app connection test and Skillodontics’ HTTP catalog test returned
four published programs each. The live settings screen was visually inspected.
External customer domains and deployed cross-site integration remain unverified;
URLs currently point to the local preview. Limits are per IP/server instance, not yet
a shared production quota.

October 13 journey review: repaired faculty workspace access and introduced admin team
management, explicit teaching assignments, capability-based navigation and read-only
marketing lead/catalog/results access. Faculty sees only assigned programs and offerings,
with workshop attendance and curriculum preview. Coordinators do not see admin settings
or academy-wide finance totals. Disabling a staff account denies existing sessions;
removing a teaching assignment denies that offering immediately. All-session attendance
now determines workshop attendance state, with duplicate check-ins producing no duplicate
events. Enrollment locking serializes check-ins for the same learner; real Postgres
multi-connection verification is still required.

Course authoring now supports persistent edits, ordering and reversible archive/restore.
Archived lessons are excluded from learner content and completion requirements. Restore
appends to the active curriculum, avoiding position collisions after a reorder. Lesson
and curriculum revision checks reject stale submissions; replacement media requires an
explicit progress reset. Existing certificates remain unchanged. Faculty/coordinators
can inspect assigned course learner progress, required lessons and post-test status.
A full media upload lifecycle remains open. Assessment updates are recorded below.

Validation: `npm test` passed all 54 tests; `npm run build` passed. The lazy-loaded HLS
bundle still produces Vite's size warning and needs measured mobile playback/performance
review. HTTP tests use isolated PGlite databases and cover both academies; this is not a
claim of production Postgres concurrency or real payment/video-provider verification.

Browser evidence (local Icode sample only): admin created a sample faculty member and
assigned a workshop/course; faculty signed in, viewed its workshop schedule/roster and
previewed assigned course content. Admin added an optional sample lesson, edited it,
moved it, archived it, restored it and archived it again. The sample fixture is retained
in the archive. Course learner rows were inspected, and the curriculum layout was checked
at 390px width with no page-wide horizontal overflow. Full keyboard/screen-reader and
other role/browser combinations are still pending. Evidence images are in
`../../work/journey-review/` (`faculty-workshop.png`, `course-authoring.png`, `course-mobile.png`).

October 13 assessment and recovery update: post-tests now keep immutable versions with
question snapshots, scoring rules, change reasons and actor/time. Stale saves and stale
learner submissions are rejected. Submissions use an enrollment-scoped idempotency key,
so transport retries cannot spend another attempt. Pass/fail uses the exact fraction of
correct answers, avoiding rounding a below-threshold score into a pass. Learners see their
attempt history and the version they passed; prior passes and certificates remain valid
when authors revise the current test. Existing scores without historical question evidence
remain explicitly marked as legacy, with no invented backfill of their assessment version.

Exhausted learners can request another attempt. Admins/coordinators have a pending-request
inbox and record approval/decline reasons. Approval grants 1–5 additional attempts, once;
faculty can inspect only assigned learner history and cannot approve. Attempt/grant writes
serialize on the enrollment, and all grants and authoring changes produce audit/outbox
records. These events are not external notification delivery. General course access expiry
continues to apply, and scores cannot be overwritten through application SQL.

Validation: all 62 automated tests and the production build pass. Eight additional tests
exercise both academies, stale revisions, exact scoring, retry/concurrent-final-attempt
handling, retake approval and denial, privacy/tenant gates, certificate preservation and
migration of legacy attempts. These are PGlite tests; real Postgres concurrency remains an
open release gate. No real learners or provider messages were involved.

Browser verification: a local Icode sample learner exhausted three attempts, requested an
extra attempt, received an admin approval for one attempt, and passed. The portal correctly
showed license verification as the outstanding certificate requirement. The admin revised
the sample question wording; history displayed four attempts against version 1 and zero
against version 2. A narrow-screen navigation bug was fixed: the staff sidebar now scrolls,
sign-out is reachable, and a closed drawer is absent from the accessibility tree. Evidence:
`../../work/journey-review/post-test-recovery.png`, `retake-approved.png`,
`assessment-version-history.png`. Full assistive-technology and production acceptance remain open.

October 13 catalog journey review: admin/coordinator can persistently edit programs,
workshops and course details, manage ticket tiers and scoped discount codes, and archive
or restore listings. Archiving hides all public API/checkout entry points and closes
sales; enrolled learners retain access and certificates. Restoration does not reopen
sales automatically. Archive is not an event cancellation or refund workflow.

Program credit defaults are copied to offerings. Subsequent default changes cannot alter
existing offerings or issued certificates. Schedule/capacity edits preserve session IDs,
check session-credit totals, account for paid seats/live checkouts/staff holds, and use
revision checks. Attendance/certification evidence prevents structural schedule or credit
changes until a separate correction workflow exists. Academy-local times reject invalid
and ambiguous DST times; multi-day workshop creation retains local start times over DST.
Existing course expiry dates remain unchanged when staff alter future access durations.

Ticket changes retain existing order totals. Active status, sale windows, group minimums,
allocations, deposit eligibility and coupon scope/limits are enforced on the server.
Expired, disabled, private and exhausted coupons are excluded from the appropriate
public offer resources. Learner checkout selects an individual tier by default, shows
quantity guidance/allocation remaining, and displays program learning objectives.

Validation: all 70 automated tests and production build pass. Eight new catalog tests
exercise both academy/admin/coordinator paths, unauthorized roles, cross-tenant references,
stale submissions, paid/reserved/held capacity, attendance safeguards, price snapshots,
ticket availability, coupon limits and archive/access preservation. These tests use
isolated PGlite databases; real multi-connection Postgres and provider acceptance remain
open. Vite still warns about the lazy-loaded HLS bundle size.

Browser evidence: an attempt to reduce the sample workshop below 14 booked seats was
rejected; a valid room change and program objectives saved and appeared on checkout.
A sample group tier (minimum 2, allocation 4) saved; checkout selected a standard seat by
default, switched to quantity 2 for the group tier, and rejected quantity 5 with guidance.
A private program discount saved with its scope and usage count. The 390px checkout had
no horizontal overflow. Evidence: `work/journey-review/catalog-ticket-management.png`,
`catalog-mobile-checkout.png`, and `catalog-discount-management.png` relative to the task
root's journey-review directory. All actions used synthetic local data; no payment,
message delivery or live academy publishing occurred.

October 13 media journey review: added course-scoped private PDF and video assets, ready-file
selection, archive/restore and replacement safeguards. PDFs validate size, pages, encryption
and automatic actions, use immutable content hashes, and are served through authenticated
access/expiry checks. Production uses a GCS adapter; development storage is clearly labeled
and has no production fallback. No public document URLs are created.

Mux direct uploads persist an intent before the provider call, support progress and
pause/resume, recover uncertain creation by correlation, and accept provider-confirmed
signed-only assets and durations. Raw signed asset webhooks have durable failure records
and duplicate handling; status refresh reads current provider state. Actual Mux upload,
transcoding/playback, GCS permissions and provider interruption recovery remain unverified.

The learner PDF reader has page navigation, zoom, keyboard panning, end-of-document UI
completion gating and saved page resume. A browser review caught a lost final reading
position; saving now runs after page changes and flushes when leaving the reader. Video
uses saved position on load, but real mobile playback and pause/end checkpoint refinement
remain open. The server requires PDF access evidence, not a claim of proven reading.

Validation: all 78 automated tests and production build pass. Eight media tests cover both
academies, private role/enrollment/expiry boundaries, immutable documents, replacement
resets, archive restrictions, provider-authoritative readiness, uncertain-create recovery,
signed webhook retry/deduplication and mocked Mux HTTP request contracts. These tests use
PGlite and mocked media services; no real provider, GCP deployment or production acceptance
is implied. Main JS is approximately 366 kB, lazy PDF JS 441 kB plus a 1.26 MB worker, and
lazy HLS 593 kB before compression. Vite's HLS bundle warning and mobile performance gate
remain open. Logs: `../../work/media-tests.log` and `../../work/media-build.log`.

Browser evidence: an admin uploaded a synthetic two-page handout and attached it to an
optional sample lesson; staff preview rendered it. The learner could not complete it
before reaching the end, resumed page 2 after leaving/re-entering, and completed it with
4/4 lessons shown, retained after a new sign-in. Completed lessons no longer show the
read-to-complete prompt. At 390px, fit-width and 200% zoom kept horizontal overflow inside the
reader; keyboard right-arrow panning worked. Evidence in `../../work/journey-review/`:
`pdf-teaching-preview.png`, `pdf-learner-completion.png`, `pdf-mobile-zoom.png`. The local
sample lesson and file remain labeled as review fixtures. Full assistive-technology,
large-document, all-browser and live-provider validation is still required.

October 13 course access and workshop inclusion review: course enrollment no longer requires
a fabricated order. Admin/coordinator grants have explicit reasons, duration or lifetime
access, retry-safe IDs and audited revocation. Existing contacts match by mobile without
overwriting profile or consent. Multiple sources share one learner/course enrollment;
revoking a grant preserves other valid access, learning progress and issued certificates.
Only courses can have orderless enrollments. Purchase renewals retain the original order
and learner record and add a source tied to the new order, preserving progress.

Workshops can include pre-work on confirmed payment (including deposits) or recordings
after all sessions are attended. Adding an inclusion backfills eligible existing learners.
Unassigned group seats receive access when assigned. Each workshop/course pair has one
unlock rule, preventing pre-work from exposing purportedly attendance-gated recordings.
Stopping future grants or changing duration preserves issued grants and their dates.
Cancelled/transferred/no-show/expired source enrollments, cancelled workshops and invalid
payment states cannot confer access. Other independent valid sources remain usable.

Learners see included learning on workshop cards, access origin/expiry and lesson progress
on course cards. Inactive access hides content and offers access options while retaining
certificates. Retake approval and certificate eligibility now use effective access across
sources. An attached course certificate still requires settlement of its source workshop
unless another valid settled/complimentary source applies. License, lessons, post-test and
feedback requirements remain enforced. Grant/expiry events are queued; no message delivery
is claimed. Staff grant history is currently capped at 200 rows and needs pagination/search.

Validation: all 87 tests and production build pass. Nine new authenticated/invariant tests
cover both academies, manual grants without money records, unchanged profiles, retry
conflicts, role/tenant/ownership denial, composite FKs, revocation and expiry, progress
retention, paid-booking backfill, all-session recording unlock, group assignment, source
cancellation, duration snapshots, stopped/re-enabled inclusions, stale edits, renewed
purchases, license-gated certificates, retained issued certificates and retake decisions
after renewal. Payment captures in tests are synthetic domain calls; no provider transaction
was made. Tests run on PGlite; real Postgres concurrency/load acceptance remains required.
Logs: `../../work/access-tests.log` and `../../work/access-build.log`.

Browser evidence: created a clearly labeled complimentary learner with 30 days' access;
the learner signed in, opened the course, completed a lesson and returned to a dashboard
showing 1/4 lessons. Included the sample course as pre-work for the sample Endodontics run;
14 existing paid/part-paid learners received grants. A deposit learner opened the included
course from their workshop card and saved progress. At 390px the dashboard had no horizontal
overflow. Proof in `../../work/journey-review/`: `course-access-grant.png`,
`granted-learner-progress.png`, `workshop-prework-mobile.png`. Recording unlock, revocation
and renewal recovery were verified in HTTP tests; their complete browser permutations,
real providers, live notices and both-academy acceptance remain open. All local actions
used synthetic sample data; existing records were not reset.

October 13 structured teaching and reading review: staff now have a visual editor for
headings, emphasis, lists, quotations and safe reference links. Lessons store versioned,
validated JSON plus server-derived plain text. Legacy text stays literal, including HTML
characters; React renders allowed semantic elements without injecting stored HTML.
Unknown nodes, executable URLs, deeply nested and oversized documents are rejected.
Old clients cannot silently flatten rich content. Corrections preserve completion unless
staff explicitly reset progress; revision, audit and tenant boundaries remain in force.

Text lessons save a proportional reading position and flush pending changes when leaving.
Text/PDF position requests serialize, and marking complete preserves the current position.
The reader supports keyboard scrolling, end-of-content UI gating and direct next actions.
Lesson selection focuses the heading. Required/optional learning is visible, and the
post-test gives an actionable reminder of incomplete required lessons. Passing the test
does not bypass the other certificate prerequisites. Scroll gating is a usability measure,
not server proof of reading; abrupt browser termination/offline recovery remains open.

Validation: 95 automated tests and the production build pass. Eight new tests cover
editor-generated JSON round trips, legacy literal rendering, unsafe content and size/depth
limits, both-academy authoring, audit events, stale saves, preservation/reset of progress,
role/tenant/expiry boundaries, hidden archived content and database/media shape guards.
Browser testing exposed and fixed a link-attribute mismatch that initially blocked saves.
The editor is lazy-loaded (~403 kB before compression); the existing lazy HLS size warning
and production/mobile performance checks remain open. Logs: `../../work/rich-text-tests.log`
and `../../work/rich-text-build.log`. These tests use PGlite, not deployed PostgreSQL.

Browser evidence: an admin created and reopened an optional synthetic formatted lesson,
including a rejected unsafe reference and a saved safe reference. Staff preview matched
the learner's semantic formatting. At 390px the editor and learner page had no horizontal
overflow. A learner resumed at approximately 454px of 1183px scroll range after leaving;
completion stayed disabled until the end. Next-lesson focus, required-lesson reminders,
completion and post-test success were verified. License verification remained outstanding,
so no ineligible certificate was issued. Proof in `../../work/journey-review/`:
`rich-text-authoring.png`, `rich-text-teaching-preview.png`, `rich-text-mobile-editor.png`,
`rich-text-mobile-completion.png`, `rich-text-learner.png`. No real learner or provider
transaction was involved. Existing sample records and the clearly labeled fixture remain.

October 13 balance and payment recovery review: learners now see their own bookings,
balances and transaction histories; admins/coordinators can inspect the same order,
buyer and payment requests. Initial/deposit requests and remaining-balance requests use
separate immutable snapshots. The database commits each request before contacting the
provider, with a short creation lease and stable correlation/idempotency identifiers.
Interrupted requests are recovered or retained as uncertain; a blind replacement is not
created. Read-back can reconcile provider-confirmed captures when a webhook is delayed.

Balance settlement preserves existing seats/assignments and can release otherwise eligible
certificates. Duplicate events/payment references cannot add payments or seats. Additional
or no-longer-applicable captures enter an unapplied review ledger without changing valid
paid access. Link delivery rechecks current booking eligibility. Real money never depends
on a redirect or a client-supplied price. Historical sample orders cannot collect payments.

Admin settings now records a revisioned, reasoned deposit cutoff (0–90 days before the
workshop). New deposit orders snapshot their deadline; existing dates remain unchanged.
Live-mode tenants without a policy cannot accept deposits. Automatic reminders, seat
release after overdue cutoffs and policy revalidation after rescheduling remain open.
Initial seat holds remain 15 minutes, while provider link requests currently expire after
31 minutes to satisfy provider minimum windows. The API stops returning expired-hold URLs
and late captures are capacity-checked, but an already-open hosted page may still collect;
a provider-expiry worker and verified customer recovery/refund handling are launch gates.

Validation: 109 automated tests and the production build pass. Fourteen added tests cover
both academies, group balances, ownership/role/RLS boundaries, immutable request snapshots,
conflicting retries, interrupted creation, competing callers, capture before create returns,
settlement certificates, stale/extra captures, expiration, deadline revisions and live-mode
policy requirements. Stripe/Razorpay HTTP contracts are mocked, including current-state
recovery, pagination, captured-amount checks, safe URLs and redacted provider errors.
Tests use isolated PGlite, not multi-connection production Postgres or real provider staging.
Logs: `../../work/payments-tests.log` and `../../work/payments-build.log`; HLS bundle size
and measured mobile performance remain open.

Browser evidence: the local sample deposit learner and admin showed matching totals;
the 390px payment modal had no horizontal overflow. Browser review removed a misleading
payment action from historical sample bookings and improved settings/summary spacing.
Saved a clearly reasoned seven-day sample Icode policy and confirmed the saved value.
Evidence: `../../work/journey-review/payments-mobile-balance.png`, `payments-staff-review.png`
and `payments-deposit-policy.png`. These actions involved no real charges or messages.
All existing sample records remain. Invoices, offline payments, refunds/transfers, daily
reconciliation, minimum-charge/account rules, worker delivery and real-account acceptance
are still required before the money lifecycle is finished.

October 13 offline payment journey review: coordinators/admins can record bank transfers,
cash or cheques with an amount, normalized unique reference, received time, explanation and
private proof upload. Staff record the amount actually received, including too little, too
much or money arriving after settlement. Mismatched amounts are retained for reconciliation,
with new hosted-payment requests paused and no seats granted. Drafts can resume after upload failure;
submitted records await admin approval. Only the recorder or an admin can upload/withdraw
a draft; only admins can approve/reject. Corrections create new records and preserve prior
evidence. A paginated/searchable queue shows drafts, pending/completed decisions and records needing reconciliation.

Proofs retain original bytes and hashes, accept static PDFs (1–30 pages), PNG/JPEG up to
5 MB, and are served only to authorized payment staff with no-store/attachment headers.
Admins can preview private PDFs/images beside the payment details. Learners see review
status without staff notes, bank references or proof access. The local adapter stores files
privately; the GCS adapter accepts the correct MIME metadata. Live bucket/IAM, retention,
malware scanning/security review and abandoned-object cleanup remain release dependencies.

Pending records do not confirm seats or change money. They block new hosted-payment
requests while preserving provider status refresh. Approval requires explicit cleared-funds
verification and acknowledgement of an already-open online request. Approval uses the same
fulfillment rules as authoritative online capture, with separate offline ledger provenance;
it is not fabricated as a provider webhook. Existing seats and learning progress remain.
Duplicate decisions cannot double-credit. If capacity or eligibility changes, or an online
payment arrives concurrently, funds are retained for reconciliation instead of overselling
or overstating applied money. A decision is final; a refund/correction workflow is still
required for reversing an approved financial record.

Validation: all 121 automated tests and the production build pass. Twelve new tests exercise
both academies, deposits/group balances, full course access, proof-required submission,
admin-only decisions, references/retries/corrections, learner privacy and foreign-tenant FKs,
static PDF/PNG validation, oversized/forged files, storage interruption/integrity, withdrawal
during upload, lost capacity, online/offline payment races, below/overpayment/after-settlement receipts and queue pagination. Existing
certificate prerequisites and online-payment tests still pass. These are PGlite and mocked
storage/provider tests, not real Postgres concurrency or live GCS/account verification.
Logs: `../../work/offline-payments-tests.log`, `../../work/offline-payments-build.log`.
The pagination fixture uses isolated SQL to avoid exhausting the real HTTP rate limit; the application limit was not relaxed. The PDF preview remains lazy-loaded; the HLS chunk-size/performance gate remains open.

Browser evidence: created the labeled local Sample Payment Coordinator account, recorded
REVIEW-OFFLINE-20261013 against sample order C26457DD and uploaded a synthetic PDF explicitly
stating that no money was transferred. The coordinator had no approval control. The learner
saw a pending notice while its balance stayed unchanged. Admin preview rendered the proof;
approval without verification was rejected, then the labeled synthetic approval settled the
sample balance and removed it from the pending queue. A fresh learner sign-in showed Paid,
zero balance and an approved bank-transfer record. Earlier seeded totals without individual
transactions are now labeled explicitly. Both 390px pending/approved dialogs had no horizontal
overflow. No actual payment, bank access, external notice or live learner was involved.

Evidence in `../../work/journey-review/`: `offline-coordinator-submitted.png`,
`offline-learner-pending-mobile.png`, `offline-proof-preview.png`, `offline-admin-approved.png`,
`offline-learner-approved-mobile.png`, and `synthetic-offline-payment-proof.pdf`. Existing
samples were retained; C26457DD now reflects this clearly labeled synthetic settlement.
Invoices/credit notes, refund execution, transfers, automatic cutoff rules, notification
workers, daily reconciliation and actual academy operational acceptance remain open.

October 13 billing journey: added administrator legal-issuer settings and explicit full-order
invoicing policy, buyer name/address/state/GSTIN capture, tenant/financial-year/type numbering,
immutable billing sources and issued snapshots, one India invoice per accepted order, and
one receipt per captured/approved charge (including unapplied receipts). Missing configuration
or buyer data creates an actionable pending document instead of undoing received money.
Admins can complete pending recipient details with a reason, without rewriting issued PDFs
or changing recorded tax. Coordinators see the searchable queue and can download; learners
see only their own documents; faculty/marketing cannot read financial documents.

The 14 new billing tests bring the full suite to **135 passing tests**. They cover both
academies, roles/ownership/RLS/FKs, deposit-plus-balance totals, duplicate captures/retries,
rollback without consumed numbers, immutable sources/files, original rate/catalog snapshots,
GSTIN validation, financial-year timezone boundaries, long-field PDF pagination, unapplied
receipts and readiness guards. Production build passes; the existing HLS size warning remains.
Cached private PDFs are stored once with a SHA-256 digest; subsequent downloads serve the
same bytes. PDF rendering happens outside capture transactions and first download storage is
concurrency safe. Docker now includes shared source at build time and fonts at runtime;
Docker execution and Cloud SQL deployment are still unverified.

Browser evidence: sample Icode billing settings saved; returning learner supplied billing
information; sample order 4E587940 was reserved, then a clearly labeled synthetic offline
payment was uploaded, previewed and approved. Invoice ICI/2627/000001 and receipt
ICR/2627/000001 appeared automatically. A fresh learner session saw the paid booking,
private invoice preview at 390px, 150% zoom and a successful PDF download. Staff proof/notes
were absent from the learner view; previous course progress and certificate gates remained.
No actual funds moved. Browser file-picker/download automation was slow and required recovery;
the completed local result is verified, but this does not establish real-device download performance.
Screens and PDF QA are in `../../work/journey-review/`; logs are `../../work/billing-*.log`.

**Tax gate remains closed for live GST.** Billing-state splitting is insufficient for
training/event services. A free-form `placeOfSupplyReviewed` flag cannot activate live GST
checkout or invoice generation. Sample CGST/SGST and IGST templates are tested, not certified
for actual filing. Complete per-offering place-of-supply rules, UTGST/exemption/export handling,
advance-voucher/final-invoice alternatives, any required IRN/QR integration and accountant approval
before lifting the gate. A tax-enabled live configuration does not silently generate a tax invoice.
Existing payments predating document support are not guessed or automatically backfilled;
those require an approved historical import. Credit notes/refunds and notification delivery remain open.

October 13 received-money resolution: admin/coordinator have a searchable, paginated queue
for received but unapplied money and paid bookings awaiting confirmation. Admins see a
server-calculated allocation preview and provide a reason plus explicit verification before
applying funds. Multiple verified short payments can jointly satisfy the required first
payment. Overpayments apply only the outstanding order balance; excess remains visible,
blocks further collection and requires refund handling. No refund or new charge is fabricated.
A booking with sufficient already-recorded funds can be confirmed after capacity returns.

The decision rechecks live seat holds/capacity, duplicate enrollment/course access, inactive
or cancelled bookings, deposit deadlines and pending offline approvals. Open provider links
require acknowledgement. It preserves existing enrollment/progress, supports course renewals,
uses the shared fulfillment/certificate prerequisites, and creates a missing order invoice
without rewriting earlier receipts. Concurrent/stale decisions and retries cannot double apply
money. Source payment identity/amount cannot be rewritten; allocation amounts only increase
within the charge. Decisions retain before/after evidence, actor/reason, audit and outbox.

Finance screens now distinguish applied payments from unapplied receipts. Learners see the
amount applied, balance and unresolved excess without staff reasons, proof or actor details.
The browser review found and fixed a misleading whole-payment review message after partial
allocation. Warning text is larger and its contrast increased from 3.16:1 to 6.02:1.

Validation: all **149 tests pass** (14 new reconciliation tests), and production build passes.
Tests cover both academies, roles/tenant/ownership, original receipt preservation, overpayment
bounds, combined short payments, rollback/retries/stale revisions, last-seat competition and
staff holds, cancelled/inactive seats/deadlines, course renewal/progress, duplicate course
bookings, provider late capture, queue pagination and SQL immutability. Repeated offline
proof fixtures call the real domain transitions to stay within the unchanged production HTTP
rate limit; reconciliation routes are exercised over authenticated HTTP. These are isolated
PGlite tests, not evidence of real PostgreSQL concurrency or provider staging.

Local browser: sample order E5233DAA (The Implant Essentials) received a clearly labeled
synthetic INR 36,000 record. The admin applied INR 35,000, confirmed one seat, and left INR
1,000 in the review queue. Original receipt ICR/2627/000002 remains INR 36,000; invoice
ICI/2627/000002 is INR 35,000. No actual funds moved. The 390px admin form has no horizontal
overflow; learner verification and images are recorded in USER_JOURNEYS.md. The file-picker
automation was very slow; its eventual success is not a real-device performance acceptance.

Still open: scheduled provider-to-ledger reconciliation, resolving unknown/orphan provider
payments, refunds/credit notes, transfers, exact-shortfall online collection, automatic cutoff
rules and notification delivery. A below-minimum set of receipts stays unresolved until more
cleared money is recorded; the UI shows the shortfall. The platform is not live-ready.
Logs: `../../work/reconciliation-all-tests.log`, `../../work/reconciliation-build.log`.

October 13 excess-return journey: a buyer or payment staff member can request return of
unapplied excess on a fully paid booking. Admin approval is distinct from actual delivery.
A separate provider attempt uses the original charge and amount; pending/uncertain states
never count as returned. Interrupted submission is recovered by provider lookup without a
second POST. Definitively failed attempts allow an explicit new attempt. Signed provider
refund events are durably processed; unknown/conflicting refunds remain in the failed inbox
for reconciliation. Verified offline returns require reference, date, internal evidence note,
cleared-funds and original-payer attestations. The product does not move bank/cash funds.

Successful returns preserve gross allocated payments, seats, course grants/progress and
original invoices/receipts. Separate immutable refund entries and excess-return counters
clear the received-money queues and update finance totals. Each return has a private,
annually numbered confirmation PDF. This is not a cancellation credit note. Learner views
exclude internal decisions/evidence and staff identity. Request and attempt records are
protected by forced RLS, tenant/order FKs, immutable financial fields and audit/outbox writes.

Validation: all **167 tests** pass (18 new refund HTTP/domain/provider-contract cases),
production build passes. Tests include both academies, partial/mixed charge allocations,
role/tenant/ownership boundaries, repeat/concurrent submission, provider failure/unknown
outcome recovery, signed webhooks, transaction rollback, evidence immutability, private
PDFs and preserved course access/progress. These use PGlite and mocked providers, not real
Postgres concurrency or live payment networks. Both INR/USD PDF renders were inspected.
The existing HLS bundle size warning remains a measured-performance acceptance dependency.

The local mobile browser completed sample order E5233DAA's synthetic INR 1,000 excess
request -> admin approval -> recorded offline return. The order stays paid at INR 35,000,
with its original confirmed seat, INR 36,000 receipt and INR 35,000 invoice. Refund
confirmation ICF/2627/000001 is available privately; no actual money moved. The unresolved
payment/refund queues both closed. Cancellation-policy refunds, applied-payment credit
notes, provider-dashboard/manual changes, durable retry/daily comparison workers, proof-file
attachment for offline returns and real bank/provider acceptance remain release gates.

October 13 whole-booking cancellation checkpoint (before course reprioritization): added
versioned policies and immutable checkout acceptance, buyer/staff requests, admin decisions,
access pauses/restoration, full-group seat release, applied/excess splits and exact deposit
waivers, provider/offline delivery through the existing return ledger, and private cancellation
statements/original-invoice-linked credit notes. Twenty new tests took the suite to 187 passing
with a passing build. Coverage includes both academies, course progress/manual-grant retention,
late captures, stale decisions, overrides, failure/retry, roles/RLS/FKs and document integrity.
This remains local PGlite with mocked providers; generated cancellation PDFs were structurally
checked but not visually accepted. Local browser review covered synthetic policy publication,
required checkout acceptance and an unpaid two-seat sample hold only. No actual funds moved.
Further payment polishing was explicitly deprioritized by the user.

October 13 complete course delivery: created Clinical Photography Foundations - Complete
Course as a separate editable draft in BOTH local academies. Six modules contain 12 required
rich-text lessons with objectives, practice, self-checks and primary references. An optional
nine-page private PDF workbook includes setup/experiment sheets, an original geometry diagram,
a five-view model exercise, quality rubric, capstone and action plan. The final assessment has
16 scenario questions, an 80% pass mark and three attempts. Estimated study/practice time is
3-4 hours. This is a text-and-workbook course; no recorded faculty videos or patient images
were fabricated. Clinical/editorial approval, named faculty and accreditation remain pending;
the draft has zero credits, unpublished program and an inactive unpriced ticket.

Admins/coordinators use Online courses -> Open complete course. Tenant-specific deterministic
identities and offering/program locks make retries/concurrent imports reuse the same draft.
Interrupted PDF storage resumes without replacing teaching edits. Reopening preserves archived
resources, authored changes, prior courses and progress. The workbook uses the same private
storage adapter (local development/GCS production); Docker build includes the content bundle.
Learner navigation groups modules with per-module completion and a collapsible mobile outline;
PDFs now expose a direct authenticated download link.

Validation: all **192 tests pass**, production build passes. Five new authenticated integration
tests cover both-tenant imports, role restrictions, unchanged old lessons, concurrent retries,
storage failure/recovery, private PDF bytes and tenant ownership, reading resume, wrong/passed
assessments, required lesson completion and preservation after reopening. All nine workbook
pages were rendered and visually inspected; page 6 spacing was corrected and rechecked.
Local browser installed both academies and granted the synthetic reviewer +919000000888 access.
Icode browser: expanded/collapsed 390px curriculum, opened/page-navigated the nine-page PDF,
verified download link, completed lesson 1, used Next lesson and reloaded/resumed lesson 2.
The mobile document view had 390px content/viewport widths. Course tests exercised completion
and grading in both tenants; the browser did not complete all lessons or submit a full quiz.
The existing HLS chunk warning and real GCS/Mux/production acceptance remain open.
Evidence: ../../work/full-course-all-tests.log, ../../work/full-course-build.log,
../../work/journey-review/full-course/, output/pdf/clinical-photography-workbook.pdf.

October 13 course publishing and recoverable editing: migration 024 separates academy lesson
work in progress from learner-visible curriculum. Admin/coordinator editors autosave drafts,
reopen them after reload, preview text/private files, publish explicitly and discard/restore
unfinished work. Changing media still requires an explicit progress reset on publication.
A draft save never changes curriculum revision, completion requirements or learning progress.
Publishing reuses the existing lesson-validation and completion rules atomically; exact retries
cannot create duplicate lessons. Revision checks block newer draft or published-lesson changes
from being overwritten. The editor retains unsaved text on failure and can preserve a conflicting
edit as a separate unpublished draft. It warns before leaving with unsaved changes and saves
before normal dialog close. Autosave depends on the server; offline editing/sync is not claimed.

Draft rows have forced RLS, composite course/lesson/media foreign keys, audit triggers and
transactional domain events. Faculty, marketing and learners do not receive unpublished drafts.
Private PDF/video media previews are available to editors before a lesson exists; PDF previews
verify both the storage adapter and SHA-256 digest. Publishing checks current required lessons,
content/media readiness, a priced active ticket/sales window, course/program state and the quiz.
The review screen also flags missing faculty, description/objectives and unpublished drafts.
These are setup checks, not clinical/accreditation approval. Closing enrollment preserves existing
course rights. Existing published lessons remain available while their replacements are drafted.

Verification: all **202 tests pass** and production build passes. Ten new authenticated tests
cover both academies' incomplete/recoverable drafts, learner invisibility, idempotent saves and
publish replay, explicit progress reset, stale writes/rollback, recoverable discard, role/RLS/FK
boundaries, unready media, publication revalidation, closed-enrollment access, atomic audit/outbox,
and pre-publication private PDF access/integrity. Tests use isolated PGlite and synthetic data;
real Postgres concurrency and Mux/GCS staging remain open. The known HLS bundle warning persists.

Local browser: Icode's workbook title was autosaved to a private draft, recovered after a full
page reload, and then published as “Practical workbook & portfolio checklist · 9 pages”. The
same workbook and lesson identity remained, and the review learner stayed at 1/12 required
lessons. The private nine-page PDF rendered inside the draft editor. Publication review showed
all learning requirements configured while correctly blocking sales on inactive/unpriced tickets;
no enrollment was opened or price invented. Desktop and 390px publication views were inspected
with no page-wide overflow. Both academy server paths are tested; Skillodontics browser drafting
and live video preview have not been accepted. Evidence: ../../work/course-drafts-all-tests.log,
../../work/course-drafts-build.log and ../../work/journey-review/course-drafts/.

October 14 course communication checkpoint: learners now have a persistent Learning updates
inbox with unread filtering, 20-item cursor pagination and saved read state. It covers current
access, renewal/change, expiry and newly issued course certificates. Admin/coordinator course
access screens show the latest 30 portal updates and read times. Seven-day/24-hour reminders
use continuous effective access, suppress completed learners, respect a portal-only opt-out
and retire obsolete warnings after renewal. No external messages are sent.

A tenant-isolated outbox consumer records its own receipts, rechecks current course rights,
rolls back failed projections, backs off retries and leaves the shared outbox available to
other consumers. A bounded scheduled scan reconciles expiry without a new business event.
Development checks every minute; the production job is bundled but not scheduled/deployed.
Operational setup and known limitations are in docs/COURSE_UPDATES.md.

All 213 tests and the production build pass. Eleven new tests cover both academies, ownership,
RLS/composite tenant references, retry rollback/recovery, stale grants, effective access windows,
expiry boundaries, opt-out/consent separation, completion suppression, certificate revocation,
microsecond-safe pagination and scheduled reconciliation. Logs: ../../work/course-updates-all-tests.log
and ../../work/course-updates-build.log. The existing large HLS chunk warning remains.

Browser verified the full Icode course review learner's access confirmation, explicit read mark,
read persistence after reload, and View course resuming the saved second lesson (1/12 required
complete). The 390px inbox has no horizontal overflow (document 390/390, dialog 360/360).
Desktop/mobile captures are in ../../work/journey-review/course-updates/. No payment records,
course publishing/prices, teaching approvals or real-provider settings were changed. Actual
Postgres concurrency, scheduler capacity/monitoring and WhatsApp/email delivery remain open.
