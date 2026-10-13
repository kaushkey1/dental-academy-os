# Course portal updates

Learners have a persistent **Learning updates** inbox. Academy admins and coordinators can
review the latest 30 updates and their read status under **Course access → Learning update
history**. This is portal delivery only: it does not send email, SMS or WhatsApp messages.

## Behavior

- New access, changes to effective access, ended access and newly issued course certificates
  produce updates. Event processing checks current rights, so an old grant event cannot
  announce access that has since been revoked. Certificate notices use the current owner
  and a revoked certificate's earlier notice is retired.
- Expiry reminders appear within seven days and 24 hours of the end of continuous access.
  Lifetime access, longer grants and overlapping future renewals prevent false expiry warnings.
  Completed/certified learners are not nudged to finish remaining lessons.
- Learners can turn portal expiry reminders off. Access and certificate updates remain.
  This preference does not modify consent for external messages.
- Earlier access updates remain in history but do not count as unread after a later access
  change. Opening a notice rechecks the learner dashboard; actual course access is always
  enforced by the existing learner endpoints. Expired access retains learning records.
- The inbox uses 20-item cursor pagination with timestamp precision preserved, an unread
  filter, and idempotent read marking. Read means explicitly marked or opened, not proof that
  someone understood the content. There is no external delivery/read receipt claim.

## Runtime

Development starts the job once on API startup and every minute while the API is running.
Production deliberately has no HTTP-process timer. Schedule the built job on the same image
with a non-superuser, non-BYPASSRLS database principal and the normal production environment:

```sh
node dist-server/scripts/course-notifications.js
```

Run it every minute through the eventual hosting scheduler (for example a Cloud Run job).
The job runs migrations neither in production nor development. Apply migration 025 first.
Local CLI use requires an explicit DATABASE_URL; never open a PGlite data directory while
the development server has it open. The process logs counts, not contact data, and exits
nonzero on failures during that run. GCP provisioning and scheduler alarms remain untested.

Each invocation handles up to 50 eligible outbox events and 100 due access checks per
academy. An initial run also discovers existing enrollments and creates a current-access
baseline. Large backlogs drain over successive runs. Measure and provision throughput before
launch; the minute interval is an intended schedule, not a delivery SLA.

## Durability and operations

`course_notification_events` records this consumer's progress independently of the shared
outbox. It does not set outbox.delivered_at or consume events needed by other workers.
Event receipts and notices commit together. Transaction locks and unique notice keys guard
repeated invocations; deployment Postgres concurrency still needs a multi-connection test.

Scheduled access checks persist in `course_notification_state`. They run at the next known
access/reminder boundary and at least daily. Purchase cancellation and other upstream access
changes without one of the subscribed course events may take up to that reconciliation cycle
to appear in the inbox; course playback permissions take effect immediately. An ended access
notice is informative and does not itself revoke an enrollment.

Failure rolls back the individual projection and persists a safe error code plus exponential
backoff (starting at two minutes, capped at six hours). Later events and other academies can
continue. Monitor nonzero job exits, old unprocessed consumer receipts and overdue state rows;
investigate repeated `COURSE_NOTICE_FAILED` entries. Correct the underlying data/service
failure and allow the saved retry to run. Jobs do not send real messages or retry payments.

Not yet implemented: external provider delivery/approved templates, provider receipts,
email attachments, operational alert provisioning, historical certificate backfill, a general
notification campaign system or academy-custom reminder timing.
