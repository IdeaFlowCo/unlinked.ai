# Export-first onboarding

The canonical site (`https://www.unlinked.ai`) uses the standalone runtime,
not the legacy Next.js pages. The landing page starts the LinkedIn export in a
new tab, shows the four-step timeline and a fictional Claude example. Below
600px, its primary action opens an email draft addressed by the member to themself,
with the export and signup links. Anonymous users need no server email delivery.

After signup and the find-me/legacy-profile step, members without a completed
export see `/while-you-wait`. They can turn the default-on email reminder off,
create a Google Calendar event, download `/export-reminder.ics`, or copy the
approved assistant prompt. A dismissible reminder banner stays on member pages
until an export completes; dismissal lasts for the current browser session.
Calendar events start 48 hours after the calendar action, last 10 minutes and
link to `/import`. The upload page also links to requesting an expired archive
again.

## Runtime email

No new environment variables or dependencies are required. Existing Resend
configuration in [email.md](email.md) must be enabled, with a valid email secret
and a verified member sign-in address. `export_reminder` uses the same Settings
preferences and signed unsubscribe tokens as existing notification emails.

The existing unref'd 60-second mailer timer also sweeps up to 100 signup records
per pass once they are 48 hours old. Old accounts that only sign in and signup records from before this feature
are not scheduled. A dedicated `exportReminderDueAt` marks only new signups. Signup time is persisted even when email sending is disabled, when
the email service is configured. It is never reset by another sign-in.

Each eligible member's owner-scoped imports are checked before sending. Imports completed with only skipped rows count as successful too. Failed
imports, manually added people and other owners' records do not count. An
atomic graph lock and permanent `exportReminderClaimedAt` marker permit at most
one delivery attempt per account across concurrent sweeps and restarts. There
is deliberately no retry after an uncertain provider timeout or crash, since
retrying could send a second email. A backend eligibility-read failure leaves
no claim and is retried on a later sweep. Resend's idempotency key supplies an
additional provider-side guard. Existing global provider backoff applies.

Tests: `node --test tests/export-onboarding.test.mjs tests/member-email.test.mjs tests/light-onboarding.test.mjs`.
