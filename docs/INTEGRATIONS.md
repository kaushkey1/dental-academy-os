# Architecture and boundaries

## Decisions

A TypeScript modular monolith keeps the first release operationally manageable. React
and Vite serve the interface; Express owns API and authorization. The PRD suggested
Next.js but did not require it. Explicit application services and SQL transactions were
chosen to keep tenant policy, payments and capacity allocation directly testable, and
to produce one portable Node container for GCP. No Cloudflare-specific runtime is used.

Production uses PostgreSQL / Cloud SQL. Local development and fast invariant tests use
PGlite, a WASM PostgreSQL engine, with the same migrations, constraints, and RLS policy.
This reduces setup friction but does not replace server PostgreSQL load/concurrency tests.

## Data model

Program is reusable curriculum. Offering is either a dated workshop or a self-paced
course. Workshops have sessions and capacity. Courses have lessons, post-tests and an
access duration. Tickets belong to offerings; an order contains one offering and one
ticket tier with one or more seats. An enrollment represents a seat/course entitlement.
Multi-offering carts are not currently supported.

Composite foreign keys bind related records to the same tenant. `tenant_directory`
contains only public routing metadata and is intentionally global. Tenant configuration,
contacts, staff, learning data, money movements, audit records and events have RLS.

A transaction sets a fixed restricted PostgreSQL role and transaction-local tenant and
actor settings. Do not expose arbitrary SQL or let a browser set this context. RLS is a
second boundary after HTTP authorization, not a replacement for it.

## Identity

One-time codes are generated cryptographically, HMAC-hashed, limited to ten minutes and
five verification attempts, invalidated when superseded, and consumed once. Staff must
already have an active academy membership. Learners prove mobile ownership before a
session is issued. JWTs live in HttpOnly SameSite cookies; production sets Secure. Staff
membership is read again on each authenticated request. Logout clears the cookie; there
is not yet a server-side session revocation list or a separate staff second factor.

The development-only code display is coupled to non-production mode. Production startup
requires explicit APP_MODE, HTTPS origin, external database and a secret. Never use the
development environment for live academy data.

## Transactions and events

Capacity operations lock the offering first. Availability subtracts active enrollments,
unexpired pending orders and explicit holds. Payment processing uses the same lock order.
Late captures with no capacity are recorded as review_required rather than overselling.

Provider signatures are validated over the original bytes. An independent inbound
transaction stores the raw verified webhook before domain processing. Business changes,
payment deduplication and outbox events commit together. The inbox survives processing
failure for operational recovery. Outbox delivery, scheduled reminder dispatch and daily
provider reconciliation are not implemented yet.

Certificates use a snapshot, random verification code and unique serial. The eligibility
check gates on professional verification, settlement, learning/attendance completion
and configured feedback requirements. Real accreditation configuration requires explicit
approval. The current PDF is a baseline layout, not a fully configurable or legally
reviewed CE/GST document engine. Historical correction/reissue workflows remain open.

## Production limits to resolve

- Postgres connection pooling and RLS must be tested using the actual runtime role.
- Rate limits currently use an in-process IP store plus persisted per-identifier OTP
  counts. A shared limiter and robust concurrent issuance control are required for scale.
- Staff second factor and the platform-admin boundary are unfinished. Faculty access is restricted to explicit offering assignments.
- Outbox processing, monitoring, retries, reconciliation and operational runbooks need completion.
- Private PDF storage has a GCS adapter; bucket/IAM/retention and real storage checks remain unconfigured. Certificates are rendered on demand.
- Large data tables use bounded lists, not a finished pagination/search system.
- Checkout is client-rendered; the under-two-second 4G performance target is unmeasured.
- Custom domain routing and academy-specific public origins are not implemented yet.

## Primary references checked during implementation

- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud SQL from Cloud Run](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Razorpay webhook validation](https://razorpay.com/docs/webhooks/validate-test/)
- [Stripe webhook handling](https://docs.stripe.com/events/manage-webhook-endpoints)
- [Mux signed playback and domain restrictions](https://www.mux.com/docs/guides/secure-video-playback)

## Teaching access and curriculum maintenance

The admin owns academy staff membership; coordinators can assign active faculty to
specific offerings. `offering_faculty` uses forced RLS and composite tenant foreign keys.
Faculty access is checked on every roster, curriculum, preview and attendance request;
marketing receives only catalog metadata, lead views and permitted reporting. The same
server capability map controls visible navigation and read/write controls.

Lessons are archived rather than deleted. Existing progress foreign keys remain valid;
active curriculum queries, progress writes, playback URLs and completion checks exclude
archived content. Edits carry a lesson revision; reorders carry a curriculum revision and
must list every active lesson exactly once. An offering lock serializes authoring changes.
Learner course operations take a shared offering lock, then learning/enrollment locks, so
media changes cannot race old progress writes. A stale rendered lesson must be reloaded.
Changing video identity/duration/type requires an explicit progress reset. Text corrections
preserve progress by default. Certified enrollment and certificate snapshots remain intact;
uncertified completed enrollments return to in-progress when new requirements are added.
Staff writes retain before/after audit rows and produce durable outbox events.

Post-tests keep an immutable `quiz_versions` snapshot for each author revision. Attempts
reference the same tenant, offering and version and are immutable. Pre-migration attempts
retain their scores with a null version, explicitly indicating missing historical evidence.
Learner payloads exclude answer keys and internal change reasons. Submissions require the
rendered revision and a UUID idempotency key; reusing a key with different answers is rejected.
Pass/fail compares the exact integer fraction with the configured threshold; displayed scores
have two decimal places. Prior passes remain valid and are labeled with the passed version.

Base attempt limits count all historical attempts across versions. The learner can request
a retake only after exhausting access; one pending request per enrollment is enforced by
a partial unique index. Admin/coordinator approval grants 1–5 additional attempts, subject
to a 100-attempt lifetime ceiling; faculty cannot grant attempts. Review notes are visible
to that learner. Attempt, request and approval writes take the offering lock before the
enrollment lock. Approval decisions and quiz revisions emit transactional outbox events.
Outbox events currently remain queued; no notification worker or provider delivery is implied.

## Catalog maintenance and pricing

Programs and offerings have optimistic revisions and reversible archive timestamps.
Archiving a program locks the program and then its offerings in ID order, closes open
sales and unpublishes the program. Public catalog, offer, checkout-link and enquiry
queries exclude archived records. Existing enrollment delivery remains accessible.
Restoration leaves sales closed/unpublished until an explicit staff publication action.

Offering maintenance locks program then offering. Capacity mutations count active
learners, live pending orders and explicit holds, matching allocation rules. Structural
session/credit edits also lock the offering's enrollments in ID order to serialize with
attendance and certificate issuance. Existing evidence blocks those edits. Workshop
session IDs survive time/title edits; session credits must equal the offering total.
Offering credit type is snapshotted from the program at creation and can be overridden
before attendance/certification. Course access-duration edits apply to future enrollments.

Staff enter dates in academy time, independent of the device timezone. Calendar validation
rejects nonexistent daylight-saving times and requires explicit choice of repeated times.
Draft multi-day sessions advance local calendar dates rather than fixed 24-hour intervals.
Untouched session timestamps retain their original instant, including seconds/DST offset.

Ticket mutations take the same program/offering locks used by catalog maintenance;
reservations take the offering lock and enforce active status, sale windows, group
minimums and allocated seats. Existing order amounts are snapshots. Coupons use row
locks, revisions, case-insensitive unique codes, tenant foreign keys and either program
or offering scope. Usage counts paid/partial bookings plus live pending reservations.
Private codes remain usable by a learner who knows the code but never appear in public
resources. Exhausted or disabled offers are excluded. All staff changes remain audited
and emit outbox events; no schedule-change delivery is implied until the worker exists.

## Course media lifecycle

Migration 008 adds `media_assets` with forced tenant RLS and a composite course/media
foreign key from lessons. PDF bytes are immutable, bounded and content-addressed. The
application owns metadata and authorization; private GCS owns production bytes. A local
development adapter is explicit and cannot run in production. Byte size, SHA-256 and
page count are validated before ready state; a ready file must belong to the same course
before a lesson can reference it. Active references prevent archival. Replacement resets
document-open evidence and prior progress. Staff changes are audited and emit outbox events.

Video creation persists an intent before the provider call. A stable correlation value
supports uncertain-create recovery without blindly creating a second upload. Upload URLs
are returned only to authorized course editors and not stored in audit rows. Signed-only
readiness, playback identity and duration come from a verified provider response; client
metadata cannot override them. Mux webhooks validate timestamped HMAC over raw bytes,
persist an inbox record, and read current asset state before updating media. Duplicate
events and unchanged states do not emit duplicate readiness events. The durable inbox
does not yet have an independent retry worker.

Staff previews recheck role and teaching assignment. Learner document/video routes recheck
enrollment ownership, status and expiry. PDFs have no public URLs and use private/no-store
responses; integrity is checked before delivery. PDF.js is lazy-loaded with local worker,
font, CMap and WASM assets copied during prebuild/predev. Canvas rendering virtualizes
offscreen pages, with accessible extracted text, page navigation, zoom and saved page
position. The UI requires reaching the end; the server requires successful document access
before accepting PDF completion. Neither establishes that the learner understood the content.

Production media limits remain: live GCS/Mux validation, upload abuse/retention/orphan
cleanup, large-document memory/performance measurement, provider outage operations and
custom academy domain configuration. Pre-work/recording attachments and staff access grants
use the access-source model below. Legacy imports and message delivery remain separate work.

## Course access sources and workshop fulfillment

Migrations 009–010 allow orderless course enrollments and add `course_access_sources`
and `workshop_courses`, with forced RLS, composite tenant/course/enrollment foreign keys
and staff audit triggers. A database trigger prohibits orderless workshop seats. Sources
are manual grants, workshop inclusions or later purchase renewals; the original enrollment
order remains its original purchase source. Grants never create orders or payment records.

A learner/course keeps one active enrollment for progress, attempts and certificates.
Effective access is the union of non-revoked, unexpired valid sources. Any lifetime source
makes effective access lifetime; otherwise the latest active expiry is shown. Workshop
sources recheck their parent's learner identity, enrollment state, workshop cancellation
and payment status on each access request. Paid/partial orders unlock teaching material;
certificate issuance requires a settled source or explicit complimentary grant. A revoked
source cannot cancel a separate valid source or an already issued certificate.

Granting takes a course lock before the enrollment; learner access takes a shared course
lock and re-reads the enrollment before checking sources. Workshop fulfillment takes its
workshop lock, then included courses in ID order. Program archival locks workshops before
courses to follow the same kind order. Inclusions have optimistic revisions and one unlock
rule per workshop/course pair. Configuration changes, paid capture, all-session check-in
and group assignment create missing grants transactionally. A unique attachment/parent
enrollment key prevents repeated callbacks from issuing or extending the grant again,
even after revocation. Duration is snapshotted when access unlocks. Stopping future grants
does not retract prior grants. Changes to existing durations require explicit new grants.

Renewing an expired purchase creates a new paid order/source while retaining the original
order link and all progress. Source-order composite FKs prevent cross-course purchase
references. Financial reporting remains based on orders/payments, not source counts.
Outbox events record grants/revocations/inclusion edits; dispatch, expiry transition jobs,
large-roster backfill performance, pagination and actual Postgres concurrency remain open.

## Structured lesson documents and reading recovery

Migrations 011–012 add `content_format` (`plain` or `rich-text-v1`) and `rich_content` to
lessons. Existing rows retain literal plain text. Rich text is a bounded JSON tree, not
HTML: headings 2/3, paragraphs, lists, quotations, line breaks, rules and supported marks.
The shared validator canonicalizes link attributes and only accepts http/https/mailto
references without embedded credentials or control characters. It rejects unknown nodes,
attributes, excessive nesting (12), more than 2,000 nodes, more than 30,000 text characters
or an 80 kB canonical document. The body limit remains 100 kB. The database prevents rich
content on media lessons and explicitly rejects missing document type (CHECK NULL rules).

The API derives the plain-text representation, rather than trusting a parallel client
field. Saving with an outdated editor cannot implicitly discard formatting. Existing
lesson revision checks, atomic audit/outbox records, faculty assignment and learner
access/expiry checks apply. React renders allowed semantic elements and escapes text;
there is no stored-HTML injection. Tiptap loads only when staff open an authoring modal.
Its actual schema output is round-trip tested, including canonicalized link defaults.

Text checkpoints use 0–1000 for the proportion of scrollable content. Readers debounce
and flush on unmount; the course player serializes text/PDF checkpoint requests. An omitted
position on completion now preserves the previous position. These measures cover ordinary
navigation, not offline sync or forced browser/process termination. End-of-content UI gating
is not attested reading. Completion still requires the existing server eligibility rules.

Editor references: [official React setup](https://tiptap.dev/docs/editor/getting-started/install/react)
and [content commands](https://tiptap.dev/docs/editor/api/commands/content/set-content).
The local browser test used synthetic teaching copy and accounts; live accreditation
content approval, production performance and screen-reader acceptance remain required.

## Durable payment requests and balance settlement

`payment_attempts` separates initial/deposit collection from balance collection. Each
request snapshots provider, integer amount/currency, contact details, return URL and expiry.
A database trigger prevents changing that identity or payload. Tenant RLS, composite order
and payment FKs, provider reference uniqueness and staff audit apply. One open request per
order/purpose and a 60-second lease coordinate callers. Provider I/O runs after the intent
transaction commits; recovery retains the same request instead of inventing a new charge.
An expired lease may be reclaimed; elapsed time alone does not prove the provider failed.

Fulfillment locks offering → order → attempt. Capture validates reference, purpose, amount,
currency and payment deduplication, then atomically writes payment, order, enrollments and
outbox. Balance capture updates money only, retaining seat IDs/contact assignments. Eligible
workshop and included-course certificates are reconsidered after settlement; all other
prerequisites and accreditation approval continue to apply. An extra or ineligible balance
capture is recorded with `applied=false` and a review reason; it cannot overpay the order or
revoke an otherwise valid paid booking. Staff must resolve these records through the future
reconciliation/refund workflow. Daily provider reconciliation and a dedicated exception inbox
remain open; recorded review charges are currently visible in individual order details.

Authenticated provider read-back uses the same capture domain path as signed webhooks.
Current terminal state is not overwritten by a delayed create response. Returned links
recheck order status/remaining amount/seat eligibility, including changes during network I/O.
Initial holds are 15 minutes, while provider expiry is currently 31 minutes; an expiry worker
must close held links at the application deadline before live acceptance. The late-capture
review path is not a substitute for that worker or a customer refund process.

The buyer dashboard returns its most recent 100 orders; pagination remains open. Admin-only
policy changes require a reason/revision and snapshot due dates on future deposit orders.
Production deposits require a configured policy; existing due dates are not silently changed
by policy updates. Automatic deadline reminders/cancellation are not implemented yet.

## Offline payment approval and private evidence

`offline_payments` stores immutable request details with draft → pending → approved/rejected
transitions and reasoned withdrawal. A tenant/method/normalized-reference index prevents
reusing active or approved references; rejected/withdrawn records remain visible when a
corrected record is submitted. One pending record per order avoids ambiguous approval work.
Identity, amount, file metadata/hash, submission evidence and final decisions have database
guards. Staff/tenant/order composite FKs and forced RLS apply. Approval is admin-only through
the API; upload/withdrawal belongs to the recorder or an admin. All changes are audited and
emit transactional outbox events, including the receipt/open-link acknowledgements.

File I/O runs outside the transaction, followed by an order-locked state recheck. Original
PDF/PNG/JPEG bytes use a tenant/record/content-hash key and are immutable once attached.
A concurrent withdrawal cannot attach a late upload, though the unreferenced object can
remain for the future cleanup job. Downloads recheck staff access, storage kind, size and
hash, and return no-store attachment responses. Static PDF validation rejects password
protection, automatic/script/form actions and embedded-file structures; image parsing and
pixel/file limits reject invalid or oversized evidence. This is not antivirus scanning.
PDF preview uses the existing lazy canvas/text reader, not embedded executable PDF content.

Approval atomically records the decision and calls shared charge fulfillment, linking the
payment through `offline_payment_id`. A unique posting index prevents repeated approvals
from creating another charge. Offline approval has no invented hosted attempt or webhook.
Pending claims never enter order money or enrollments. Actual approved receipts that no
longer fit the booking create the same review/unapplied records as late online captures.
Those records still need reconciliation/refund resolution; approval is not a refund tool.
Buyer summaries intentionally omit proof links, bank references and internal staff notes.
Queue pages are limited to 50 with status/search filters and a Needs reconciliation view for unapplied receipts or bookings in review. All received times are stored as
instants; staff enter device-local time and summaries display the academy timezone.

Offline recording accepts actual positive receipts even if they do not match a payable
amount, including receipts after settlement. An initial amount below the required first
payment or an overpayment stays unapplied and grants no seat. New hosted payment requests
pause while a charge remains unapplied; staff can still record and review actual receipts.
Combining underpayments/top-ups, returning overpayments and resolving those ledger entries
requires the forthcoming reconciliation/refund workflow. Valid previously paid access is
preserved. No mismatched amount is silently discarded or reported as a completed booking.

## Billing documents and immutable downloads

Migrations 017–018 add order billing context, billing profiles, annual number sequences,
document obligations/issued snapshots and canonical PDF bytes. All tenant-owned tables use
forced RLS and composite tenant references. Orders retain the original offering title,
ticket, date, rate and tax configuration; later catalog edits do not change billed amounts.
Buyer GSTIN format/checksum/state and domestic address fields are validated on booking.
Production hosted-payment creation requires a configured, active billing profile and buyer
address. Provider capture and offline approval still record received funds when billing
configuration is missing, creating pending document obligations in the same transaction.

Each charge has one receipt. Accepted India bookings have one full-order invoice at the
first payment; later receipts settle the same invoice. The academy must explicitly select
that policy and record its accountant/academy review reference. US bookings receive payment
receipts that distinguish the payment amount from full order totals. Unapplied captures
receive a payment-evidence receipt, never a new invoice or extra seat. Historical seed totals
without detailed transactions do not produce invented receipts.

Lock ordering is offering -> order -> academy billing/profile lock -> annual sequence.
Document retries lock the order then the academy. Profile edits lock the academy only.
Number allocation, issued snapshot and outbox insert share the transaction; rollback consumes
no number. Number formats are <=16 characters, with one tenant/type/year sequence. Prefix
and financial-year start are fixed after first issuance; India uses April and other academies
can select their start month. Dates use the academy timezone, and delayed issuance uses the
actual issue date rather than backdating. The payment date and balances at the payment record
remain in the immutable source. Sequence counters can only advance by one.

Admin-only missing-recipient correction changes pending document recipients with an audited
reason. It cannot rewrite an issued invoice or change a state that determined recorded tax.
Issued document rows and source fields are guarded by database triggers. PDF first rendering
runs outside the payment transaction. Canonical bytes and their SHA-256 digest are then inserted
once; concurrent downloads use the winning stored result. The application role cannot update
or delete those bytes. The current 2 MiB PDF limit bounds database storage. Cloud SQL backup
and retention planning must include these files; larger-scale archival/storage migration is
not yet implemented. Keep renderer v1 available for issued snapshots that have not yet been
materialized. No external PDF storage or renderer service is required.

PDF routes authenticate and verify buyer ownership/admin/coordinator access before reading
any bytes; responses are private/no-store attachments with nosniff and sandbox CSP. They are
not public certificate-style verification URLs. The existing canvas/text reader supplies
preview, keyboard scroll and mobile zoom. DejaVu fonts and their redistribution license are
bundled in assets/fonts; unsupported scripts leave documents pending with an explicit reason
rather than silently replacing a legal name. Additional Indian-script fonts remain a release gap.

Live GST activation/checkout/issuance is hard gated until a reviewed place-of-supply workflow
exists. A metadata flag cannot bypass it. In particular, do not treat the buyer billing state
as a universal training/event place-of-supply rule. Sample GST templates support original
CGST/SGST or IGST lines and SAC, but UTGST, exemption/export treatment, advance/refund vouchers,
credit notes, IRN/QR and real electronic-invoice compliance still require completion/review.

## Received-money reconciliation

Migration 019 adds `payments.allocated_amount` and append-only `payment_reconciliations`.
Existing charge records backfill their full amount only when `applied=true`; unapplied and
refund records start at zero. No ledger rows are invented for historical order-only totals.
For charges `applied` means fully allocated. After migration 020, a partial allocation is
resolved when the remainder has been returned; use the unallocated remainder, not this flag,
to decide whether money still needs review.
Original payment identity, amount, reference, provenance and capture-time review reason are
immutable. Allocations cannot decrease or exceed the charge; refunds must be separate entries.
Application-role deletion of payments is revoked. Reconciliation rows have forced RLS and
composite tenant/order/staff FKs, with SELECT/INSERT privileges only.

Private staff routes: GET `/api/payment-reconciliation` (25-row pages/search), GET/POST
`/api/orders/:id/reconciliation`. Coordinators can inspect; only admins can submit. The POST
requires a unique decision UUID, state digest, reason and verification checkbox. The digest
covers order money/status, payments/allocations, enrollments, purchase grants, offering state,
remaining seats and open requests. Submission locks offering -> order -> payment rows and
recomputes all eligibility rules; a changed digest is rejected. Existing matching decision
UUIDs replay the saved result; changed payloads are rejected. Independent PostgreSQL
connection/load tests are still required.

Allocation is deterministic, oldest captured charge first, capped at total minus paid. The
transaction updates payment allocations and order paid/status, fulfills existing/new access,
updates settled request state, creates any missing India order invoice, and writes decision,
audit and outbox evidence. Issued receipts remain the capture-time snapshots and are explained
as such in the current payment history. Excess remains unallocated and visible for refund
resolution. Pending offline approvals must be decided before applying funds. Open online
requests require acknowledgement and remain monitored; a later capture cannot add seats or
overstate paid money. This workflow makes no external provider or banking call.

`fulfillPaidOrder` is shared with authoritative provider/offline capture. Initial fulfillment
preserves course renewal progress; settlement rechecks certificate eligibility for both direct
purchases and associated course grants. Buyer history exposes amounts/time/outcome only;
internal reasons and staff identity remain private to payment staff. Scheduled provider
comparison, orphan captures and applied-payment cancellation refunds remain release gates.
Excess-return execution is described below.

## Excess payment returns

Migration 020 adds `excess_refund_requests`, `refund_attempts`, charge `unallocated_refunded`,
order `excess_refunded`, original-charge/attempt FKs on refund ledger entries, and a separate
`refund_receipt` billing kind/annual F series. Only fully paid, confirmed orders can request
unallocated excess here. Applied money and cancellation policies are deliberately separate
workflows still to implement; this route cannot cancel access or turn a partial booking into
an excess refund. The current full Phase 1 contract still includes those workflows.

Private routes: POST `/api/{orders|learner/orders}/:id/refunds` and
`/api/{orders|learner/orders}/:id/refunds/:refundId/decision`; GET `/api/refunds` provides
staff search and 25-row status pages. Only the original requester/admin can withdraw a
pending request, and only an admin can approve/reject it. Approval freezes internal note
and buyer response. One open request per charge prevents overlapping reservations. All
amounts are positive integer minor units, capped by charge minus allocation minus return.

POST `/api/orders/:id/refunds/:refundId/send` needs an explicit confirmation and stable
attempt UUID. POST `.../refresh` only looks up an existing request. Preparation locks
offering -> order -> refund request; the provider call runs outside the DB transaction.
A 45-second lease prevents simultaneous dispatch. Unknown results remain uncertain; lookup
paginates original-charge refunds by saved attempt metadata and never repeats a POST.
Failed/cancelled provider attempts are terminal and retained; an explicit retry gets a new
attempt ID. Pending/required-action states preserve the obligation without reporting success.
Provider ID, charge, currency, amount and metadata must match the immutable request before
any observation is accepted. Terminal conflicts require reconciliation, not silent reversal.

Completion locks offering/order and request/charge, increments only the excess-return
counter, inserts a separate original-charge-linked refund entry, saves terminal evidence,
creates the confirmation document and emits audit/outbox writes in the same transaction.
Original allocation/receipt/invoice rows never decrease or change. Current unapplied money
is `amount - allocated_amount - unallocated_refunded`, including queue/report calculations.
The `orders.refunded` field remains the applied-payment refund total; `excess_refunded`
tracks unallocated returns separately. No seats or access grants change in this workflow.

Offline return records require an admin's cleared-funds and original-payer attestations,
reference, method, actual return time and private evidence note. References are unique per
academy after whitespace/case normalization. The minute-resolution UI permits a return
within the approval minute, rejects older dates/future dates beyond five minutes, and does
not perform a bank transfer. A proof attachment and real bank acceptance are still needed.
Learner projections omit internal notes/evidence and staff identities. Canonical private
PDF delivery reuses the billing authorization/cache path; refund confirmations use renderer
v2, and existing invoice/receipt renderer v1 output remains supported.

## Excess refund providers

Stripe/Razorpay excess returns use the existing academy payment credentials. Stripe POSTs
`/v1/refunds` with the original PaymentIntent, integer amount, customer-request reason,
`metadata[refund_attempt_id]` and `Idempotency-Key`. Razorpay POSTs
`/v1/payments/{payment_id}/refund` with amount, normal speed, attempt notes and the required
`X-Refund-Idempotency` header. A lost response triggers lookup-only recovery; no replacement
POST is sent, including after an idempotency window could have expired. Lookups paginate
up to 5,000 records and leave larger/ambiguous results unresolved for finance review.

Subscribe Stripe `refund.created`, `refund.updated`, `refund.failed` and Razorpay
`refund.created`, `refund.processed`, `refund.failed` to the existing signed raw-body tenant
webhook route. Success is recorded only for a matching approved attempt and original charge.
Out-of-order pending events do not reverse terminal success. Unknown/manual-provider refunds
and terminal conflicts stay in the durable failed webhook inbox; their operator resolution
and daily provider comparison remain unimplemented release dependencies. A provider response
can require extra action; staff must use the original provider dashboard, then refresh.
No arbitrary provider-supplied action URL is opened by the application.

Offline returns use an admin-verified record only, with an original-payer attestation and
reconciliation reference; they do not invoke payouts or banking APIs. Confirmation PDFs
record the excess return and preserve the original invoice. They are not credit notes.
Real sandbox permission/configuration, pending/failure/timeout behavior, posting times,
manual-dashboard refunds, disputes and production-role Postgres races must be accepted
before live use. Unit/HTTP tests use synthetic data and mocked provider responses.

Primary adapter references checked October 13, 2026:

- [Stripe create refund](https://docs.stripe.com/api/refunds/create) and [refund states](https://docs.stripe.com/api/refunds/object).
- [Razorpay idempotent normal refunds](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/).
- [Razorpay per-payment refund list](https://razorpay.com/docs/api/refunds/fetch-multiple-refund-payment) and [refund lookup](https://razorpay.com/docs/api/refunds/fetch-with-id).
