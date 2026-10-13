# Product value and journey review

Started October 12, 2026. The goal covers both academies and every Phase 1 role.
Status: active implementation and review, not release acceptance.

For each journey, verify the user's outcome, happy path, recovery from mistakes,
authorization, persistent data, keyboard/mobile use, and understandable next action.
A passing endpoint or attractive screen alone does not establish usefulness.

| User                      | Outcome and complete journey                                                                  | Initial findings                                                                                 | Verification still required                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Platform admin            | Create academy, configure plan, monitor aggregate health, provide audited support             | No usable platform-admin journey                                                                 | Dedicated identity boundary, provisioning, aggregate reports, support access                       |
| Academy admin             | Onboard team and providers, approve catalog/prices/policies, oversee money and delivery       | No team management, incomplete catalog editing and financial lifecycle                           | Onboarding through reconciliation, reporting, settings, permissions and recovery                   |
| Coordinator               | Turn an enquiry into a booking, manage seats and balances, admit learners, issue certificates | Missing holds UI and ownership; cannot fully maintain catalog; settings link incorrectly visible | Leads through confirmed booking, payment exceptions, attendance, certificate prerequisites         |
| Marketing                 | View catalog and leads, copy booking links, inspect per-run results and export orders         | Lead view absent; workshop/course links opened forbidden screens; unnecessary write controls     | Read-only journeys, useful per-run results, attribution, no roster or private teaching access      |
| Faculty                   | Find assigned teaching, read curriculum, access own roster and record attendance              | Login succeeds but workspace denies entry; no staff-to-offering assignments                      | Own-run access, assignment removal, cross-tenant denial, attendance and teaching content           |
| Learner                   | Discover, book, pay, complete profile, attend/learn, receive and verify certificate           | Balance/refund/transfer requests and profile editing missing; video/provider journeys unverified | New/returning learner, deposits, expiry, failed payment, progress resume, quiz retries, completion |
| Clinic buyer              | Purchase seats, assign colleagues, track unassigned seats and resolve mistakes                | Initial group assignment exists, reassignment/recovery incomplete                                | Duplicate participants, ownership, transfer, billing, invitation and payment recovery              |
| Academy website developer | Find connection details, list current catalog, create checkout/enquiries, handle changes      | Local API works; production quotas, pagination, pricing/content and outbound webhooks missing    | Both tenant websites, invalid origins/keys, rotation, errors and deployed acceptance               |

## Work order

1. Repair role access and navigation, add team administration and explicit faculty assignments.
2. Finish catalog and course authoring so staff can correct, reorder and retire content safely.
3. Test the full learner/clinic booking journey and complete money handling and recovery.
4. Complete operational follow-up, attendance, certificate and notification journeys.
5. Complete platform administration, reporting, data ownership and migration workflows.
6. Run both-academy acceptance, accessibility/mobile and production infrastructure checks.

Track implementation evidence here and release dependencies in `RELEASE.md`. Local
sample actions must remain distinguishable from real provider delivery and live acceptance.

## Review log

- October 12: inspected current PRD role matrix, server authorization, workspace UI and
  release gaps. Faculty is blocked at `/api/workspace`, marketing lacks lead visibility,
  and coordinator navigation exposes admin-only settings. Role repair in progress.

- October 13: role repair implemented. Team management, explicit faculty assignments,
  own-offering access, revocation, marketing leads and role-specific navigation are covered
  by ten new authenticated tests across both academies. Multi-day attendance now remains
  incomplete until all sessions are recorded. Admin team/assignment and faculty workshop
  and curriculum preview paths were exercised in the local browser.
- October 13: added lesson edit, reorder, archive and restore, optimistic revisions,
  explicit media replacement resets, and course learner progress views. Nine additional
  tests cover both-tenant maintenance, preservation of progress/certificates, stale edits,
  role boundaries, archive recovery and completion rules. Local browser exercise covered
  the full add → edit → reorder → archive → restore path with clearly named sample content;
  mobile curriculum layout checked at 390px. All 54 tests and production build pass.

- October 13: implemented immutable post-test versions, retry-safe submissions, exact
  scoring thresholds and learner attempt history. Added a learner → academy retake request,
  admin/coordinator decision, shared request inbox and faculty read-only assessment view.
  The complete exhausted-attempt → request → approval → passed result path was exercised
  in the local browser. The remaining license requirement stayed visible instead of issuing
  an ineligible certificate. A subsequent question revision retained earlier version-linked
  scores. The staff sign-out control is now reachable on short screens. All 62 tests and
  the production build pass; real Postgres/provider/full-role acceptance remains pending.

- October 13: catalog maintenance added for admins/coordinators, with safe program/offering
  edits, archive/restore, pricing and scoped discounts. Both-tenant HTTP tests verify
  retained learner access, capacity/attendance/credit safeguards, order-price snapshots,
  coupon limits, role restrictions and stale writes. Browser checks cover rejected capacity
  reduction, saved room/objectives, group pricing/allocation, discount scope, and learner
  quantity recovery. The 390px checkout has no horizontal overflow. All 70 tests and
  production build pass. Schedule-change notification delivery, cancellation/refunds and
  corrections after attendance/certification remain open.

- October 13: implemented private course media upload/selection and recovery. Eight new
  automated tests cover both academies, role/expiry/tenant checks, document replacement,
  immutable storage, signed-only video readiness, uncertain creation and durable webhook
  retry. A real local browser journey uploaded and previewed a synthetic PDF, resumed
  the learner on page 2 and completed the lesson only after reaching the end. Fixed a
  lost-position bug found by leaving/re-entering quickly; added mobile zoom and keyboard
  panning after fit-width text proved too small. The 390px page has no horizontal overflow.
  All 78 tests and the production build pass. Mux/GCS services were mocked in tests;
  their live staging and mobile video acceptance are still open.

- October 13: added reasoned course grants/revocation, multiple access sources, expiry and
  renewal without losing progress or fabricating money. Workshops now include pre-work on
  payment and recordings after every session, including existing-booking backfill and
  later group assignment. Learner cards explain access and show progress. Retake approval
  now respects renewed/granted access. Nine new tests cover the access lifecycle for both
  academies; all 87 tests and the build pass. Browser checks prove staff grant → learner
  sign-in → course lesson → saved dashboard progress, and workshop inclusion → deposit
  learner pre-work access. A 390px check found no horizontal overflow. Source revocation,
  recording unlock and renewal have HTTP evidence; full browser permutations remain open.

- October 13: completed structured text authoring and reading. A staff-created formatted
  lesson saved, reopened and rendered consistently in teaching preview and the learner
  portal. Browser review caught a real editor/server link-attribute mismatch, now fixed
  and covered by an editor-schema round-trip test. Text reading resumes across course
  exit/re-entry; completing text or PDF no longer erases the saved position. Required and
  optional learning is clear, next actions focus content, and post-tests offer a direct
  route to unfinished required lessons. The 390px editor and reader fit without horizontal
  overflow. The sample learner completed the required lessons and passed the post-test;
  the unverified license still prevented certification. All 95 tests and the build pass.
  Rich content security, both-academy role/tenant boundaries and preservation rules have
  automated coverage; full browser/assistive technology and offline recovery remain open.

- October 13: added buyer/staff booking and payment history, initial/deposit/balance request
  recovery, unapplied-capture review records and reasoned deposit due-date settings. Group
  balance settlement retains existing seats. Tests verify role/tenant/ownership restrictions,
  interrupted and concurrent requests, capture before creation returns, duplicate/extra
  charges, immutable requests, expiry and certificate prerequisites. Browser verification
  shows matching staff/learner totals and a usable 390px dialog; misleading payment actions
  on historical sample orders were removed. Saved a seven-day policy for new local Icode
  bookings with a synthetic-review reason. All 109 tests and the build pass. Provider calls
  are mocked; real account staging, hosted-page expiry, invoices, refunds, offline approval,
  cutoff automation and daily reconciliation remain open.

- October 13: offline payment recording now includes private original proof, a durable draft,
  an approval queue and final reasoned admin decisions. The coordinator → learner pending →
  admin proof preview/verification → learner settled journey ran in the browser with an
  explicitly synthetic receipt. Coordinator approval is unavailable, and an admin must
  attest that funds were verified. Inline proof preview was added after download-only review
  proved awkward. A seeded amount without individual transactions is labeled rather than
  hidden when the new charge is recorded. All 121 tests/build pass, including both-academy
  proof privacy, retries, corrections, group seats, course access, lost capacity, concurrent
  payment handling, mismatched receipts and queue pagination. Pending/approved mobile dialogs fit at 390px.
  Real bank/cheque operating procedures, GCS/IAM, refund reversal, notifications and invoice
  delivery remain unverified or unimplemented; this is not full release acceptance.

## Current next review

The user explicitly parked further payment refinements and asked for a full course.
The complete photography course is now ready for academy review in both local academies.
Continue useful learner/staff journeys now that course drafts and publishing are implemented; keep other
Phase 1 release requirements tracked without returning to payment micro-refinements.
Real content/faculty/accreditation and provider approvals remain separate release dependencies.

- October 13: billing journey implemented and reviewed. The admin can configure legal issuer,
  annual numbering and issuance policy; the learner supplies billing details and sees a price
  breakdown; coordinators find pending/issued documents; admins repair pending details with a
  reason; the buyer previews/downloads their own immutable invoice and receipts. Deposit and
  balance payments never create a second full-order invoice. A late/extra receipt remains
  clearly unapplied. Both-academy role/ownership tests, rollback/numbering, tax snapshots and
  immutable downloads pass. Total: 135 tests and production build. PDF renders were visually
  inspected for INR/GST, USD/deposit and long multi-page fields.
- Local browser check created a synthetic Icode Anterior Aesthetics booking for sample learner
  +919000000000, order 4e587940-3b17-4042-a416-77090d3f981c. Its billing name/address explicitly
  identify local review data. Offline record bc51715b-6fb8-4a40-a142-51e9b64ad2d1, reference
  REVIEW-BILLING-20261013, INR 35,000, was approved using a proof labeled NO MONEY TRANSFERRED.
  It is now paid with one confirmed seat, invoice ICI/2627/000001 and receipt ICR/2627/000001.
  Existing learning progress remained 1/5 and the license/certificate gates stayed pending.
  Icode's billing profile is an explicitly synthetic entity with billing@example.com; it is
  not an actual legal/tax configuration. No sample records were deleted or reset.
- Learner mobile review at 390x844 verified private invoice text and 150% zoom; the invoice
  downloaded successfully to Downloads/ICI-2627-000001.pdf. Native automation stalled once on
  file selection and took a long time on download, so real-browser performance needs separate
  acceptance. Screens: billing-settings.png, billing-learner-mobile.png and billing-documents-mobile.png
  in ../../work/journey-review. Tax jurisdiction rules, live GST, advance/credit documents,
  historical import, other scripts and real accountant approval remain open.

- October 13: received-money reconciliation now has a complete staff review → admin allocation
  → learner confirmation path for recoverable bookings. Coordinators can inspect the queue
  and calculated proposal; admin decisions are verified, reasoned, idempotent and audited.
  Multiple verified short receipts can be combined; overpayments allocate only the remaining
  price. Excess is still visible for a later refund decision. Existing seats/progress and
  capture-time receipts are preserved. The admin can confirm a previously unfulfilled paid
  order only after current capacity, holds, duplicate-access and deadline checks pass.
  All 149 tests and production build pass, including 14 new authenticated/domain tests for
  both academies, last-seat competition, money bounds, immutable evidence, roles/tenant
  privacy, stale decisions, rollback, late provider capture, course renewal and pagination.

  Browser review: existing sample learner +919000000000 reserved The Implant Essentials,
  order E5233DAA (`e5233daa-0aee-4e75-980e-8bf5316cc6a2`), with billing name explicitly labeled
  SYNTHETIC RECONCILIATION REVIEW. Alex Morgan recorded/approved synthetic INR 36,000 with
  proof `synthetic-reconciliation-proof.pdf` and reference REVIEW-RECONCILIATION-20261013.
  Offline record `69d6453d-94f2-4fe4-8f50-30e0df02220f` is retained. The initial overpayment
  created no enrollment. Admin applied INR 35,000 with an explicit synthetic resolution
  reason, confirmed one seat, and left INR 1,000 unapplied. The queue and finance totals
  show that excess; refund remains zero. The sample receipt ICR/2627/000002 stays INR 36,000
  while the new invoice ICI/2627/000002 is INR 35,000. No money or external messages moved.

  A fresh learner sign-in showed the paid order and confirmed workshop, preserved earlier
  workshops/course progress (1/5 lessons) and license/certificate gates, and displayed the
  allocation history without staff notes/proof/reason/identity. The browser check caught
  incorrect whole-payment review wording after partial allocation; it now states exactly
  INR 35,000 applied and INR 1,000 still under review. Warning contrast improved to 6.02:1
  with 13px text. Admin and learner dialogs at 390px had clientWidth=scrollWidth=360px.
  Viewport was reset after verification. Evidence in `../../work/journey-review/`:
  `reconciliation-admin-mobile.png`, `reconciliation-admin-result-mobile.png`,
  `reconciliation-queue.png`, `reconciliation-learner-mobile.png`, and
  `reconciliation-learner-history-mobile.png`. Admin images predate the warning contrast
  adjustment; final learner images show the corrected appearance and message.

  Remaining value gaps: the excess cannot yet be refunded through the product; requests
  below the first-payment minimum need additional cleared receipts and cannot yet collect
  the exact shortfall online. Daily provider comparison, orphan payment recovery, transfer
  and credit-note workflows, automatic cutoff rules, notification delivery and real provider/
  Postgres acceptance remain open. Slow browser file-picker automation does not demonstrate
  real-device upload performance. No live-readiness claim is made.

- October 13: excess-return journey now completes learner request/withdrawal -> admin decision
  -> original-provider processing or verified offline return -> learner confirmation. Coordinators
  can request/review but cannot approve or send refunds; faculty and marketing are excluded from
  private payment operations. Marketing per-offering reporting distinguishes allocated payments,
  booking refunds and excess returned. The admin can inspect saved offline-return evidence;
  learners only see the public response/status/reference. Historical allocation wording now says
  "unapplied immediately after this decision", preventing stale history from implying a new debt.

  Browser review reused E5233DAA, without resetting samples. The buyer requested its INR 1,000
  excess with a SYNTHETIC REVIEW reason. Admin approved with separate internal/public messages,
  then recorded synthetic reference `SYNTHETIC-RETURN-E5233DAA-20261013`. No real funds moved.
  The return attempt is `3d3323f3-b8fd-4bf5-9882-13cd6f48c359`; original receipt and invoice remain
  unchanged. Confirmation ICF/2627/000001 (document `562fecbe-1b92-432b-aea4-1ac8bb708e1a`)
  previews in the private PDF reader. Finance shows INR 1,000 returned, zero unresolved money,
  and zero open refund requests. Fresh learner sign-in preserves all three workshops, included
  course progress 1/5, and existing license/certificate gates. At 390px the dialog measures
  clientWidth=scrollWidth=360px. This verifies the synthetic local path, not a live refund.

  Evidence: `../../work/journey-review/refunds/learner-request-mobile.png`,
  `admin-confirmation-mobile.png`, `learner-return-mobile.png` and `learner-billing-mobile.png`.
  Isolated INR/USD refund confirmation PDFs were rendered and visually inspected in that folder.
  Build and all 167 tests pass. Full cancellation/refund policy, partial seat/group cancellation,
  transfers, credit notes, offline refund proof attachments, provider-side manual reconciliation,
  background retries/notifications and actual both-academy operating acceptance remain open.

- October 13 course priority: built a six-module, 12-lesson Clinical Photography Foundations
  review course with original practical activities, self-checks, a nine-page private workbook,
  capstone and 16-question versioned assessment (80%, three attempts). Staff can open an
  editable complete course from Online courses. Both local academies now contain it as a
  separate draft; existing sample courses and their progress are preserved. Reviewer mobile
  +919000000888 has complimentary access in either academy (development OTP shown locally).
- Learner value: grouped module navigation shows completion; mobile curriculum collapses
  after choosing a lesson. PDF reading includes zoom/page controls and direct download for
  offline practice. Browser verified Icode lesson 1 completion, next lesson, persistence on
  reload and resume into lesson 2; the workbook rendered and advanced to page 2 on a 390px
  screen without document-wide overflow. Screenshots are in ../../work/journey-review/full-course/.
- Course integrity: 5 new tests verify both academies, roles/tenant isolation, existing record
  preservation, retry/concurrent creation, interrupted PDF upload recovery, private document
  bytes, reading checkpoints, a failed then passed quiz, required lesson completion and
  retained progress/editorial choices on reopening. All 192 tests and the build pass. PDF
  pages were visually inspected. Full browser quiz completion and live provider checks were
  not performed. Faculty review, approval and accreditation are not implied by the sample
  course; it remains unpublished with zero credits and inactive pricing.

- October 13 academy course journey: editor saves now create private, durable lesson drafts.
  Autosave/recovery, text/file preview, explicit publication and recoverable discard make it
  possible to prepare changes without exposing unfinished teaching. Failed/stale saves retain
  the editor's text, and a conflict can be kept as a separate draft. Saved drafts are shared
  between academy catalogue editors; they are hidden from faculty, marketing and learners.
- Browser evidence: changed the full Icode course workbook title, observed “Draft saved”,
  reloaded the page, recovered the saved draft alongside the unchanged published title, and
  published the update without resetting existing learning. Previewed the private nine-page
  workbook directly in the editor. Enrollment review shows required content/media/quiz checks
  and missing priced ticket/faculty work. No sales were opened. Desktop and 390px modal layouts
  fit; screenshots are in ../../work/journey-review/course-drafts/.
- All 202 tests and production build pass (10 new draft/publication/preview tests). Both-academy
  authorization, persisted drafts, learner invisibility, retries, progress preservation/reset,
  stale conflicts, recovery, media readiness/privacy/integrity and enrollment access are covered.
  Real Postgres concurrency, live GCS/Mux playback, offline editing and faculty editorial
  approval are not proven by these local tests.

- October 14 learner communication: the full course review learner received a saved portal
  access confirmation. The new inbox shows read/unread state, earlier updates, course access
  changes and expiry reminders; View course opens the existing saved learning position.
  Admins/coordinators have a per-course portal history. Completed learners are not reminded
  to finish, and longer/lifetime grants prevent false short-grant expiry warnings.
- Browser evidence: Icode reviewer +919000000888 marked the update read, reloaded, confirmed
  Read persisted, and opened lesson 2 with 1/12 required lessons still complete. Screenshots:
  ../../work/journey-review/course-updates/inbox-desktop.png and inbox-mobile.png. Mobile
  document/dialog widths matched scroll widths at 390px; the temporary viewport was reset.
- All 213 tests and build pass. Eleven new isolated notification tests verify both tenants,
  roles/ownership, RLS, durable retry after simulated failure, effective expiry/reminders,
  opt-out without external-consent changes, certificates and cursor pagination. Portal delivery
  is implemented; external messages, production scheduling/alerts and real Postgres concurrent
  worker behavior still require setup/acceptance. See docs/COURSE_UPDATES.md.
