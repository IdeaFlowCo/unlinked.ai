# Removal requests and safety reports

Profiles imported from members' LinkedIn connections ("Not on Unlinked") and
recovered legacy profiles can be removed at the request of the person in them,
with or without an account (beads `unlinked-ac9.3`).

## The request

Every such profile page shows **Is this about you? Request removal**, which
opens `/people/<id>/removal` (public, `noindex`). The form asks for a reason
(this profile is about me / I act for the person / something else, which needs
details), optional details, an optional reply address and a confirmation.
Signed-in requests carry the session's CSRF token and record the reporter;
signed-out requests must not send one. A hidden honeypot field gets the normal
answer and stores nothing. Removal requests and reports share a site-wide
budget of 20 a minute and 500 a day. A member's profile cannot be removed this
way (the page says to report it instead).

## Storage and notification

`mcp-server/safety-reports.mjs` stores each request as one
`UnlinkedSafetyReport` node (constraint `unlinked_safety_report_id`, index on
`status`; listed in `deploy/private-pilot/graph-migration.mjs` LABELS) with
kind, target, reason, details, reply address, reporter hash and status. When
member email can send (`RESEND_API_KEY` and `UNLINKED_EMAIL_SECRET`, see
[email.md](email.md)), the support inbox `support@ideaflow.app` gets one email
per request, from the member-email sender, with `Reply-To` set to the reply
address. A failed or slow email never loses a stored request; the audit log
records only the event, kind, reference and whether it was emailed. Deleting
the reporter's account keeps the request without who sent it.

## Operator review

Inside the runtime container (`$RT`, `$R` as in the rollout notes):

```sh
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/safety-reports-operator.mjs list            # open requests
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/safety-reports-operator.mjs show <id>
# Remove the profile (reversible; members are never removed):
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/profile-decisions-operator.mjs remove <profileId> <you> "removal request <reference>"
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/safety-reports-operator.mjs resolve <id> <you> "removed with decision <decisionId>"
# or: dismiss <id> <you> "<why>"; reopen <id> <you> "<why>"
```

A `remove` profile decision ([profile-decisions.md](profile-decisions.md))
drops the profile, its edges and any address merged into it from the shared
index on the next build; it applies to every client and to agents. Revoke the
decision to restore it. An operator-published photo for the same id is
separate: revoke it with the photo publisher if needed.

Tests: `tests/removal-requests.test.mjs`.
