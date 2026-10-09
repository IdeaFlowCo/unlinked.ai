# Card access, guest signup, and LinkedIn share links

Work: `unlinked-5o5`; recovery: `code-csu`.

- My card is a visible main-navigation action. `/card` opens the contact-details version and includes the owner's professional details; `/card?share=public` keeps the public-only QR.
- Guests explicitly choose Sign up & add on a revocable contact card. The existing verified login transaction carries the card intent and rechecks the token, visibility and active accounts before adding the connection. Existing members can add directly with session CSRF. Views alone never connect.
- LinkedIn Share my profile links accept tracking parameters/fragments after exact-host validation. Lookup failures preserve the entered address and say whether lookup was disabled, unavailable, timed out, refused, or returned no profile. Short links are not fetched or silently treated as person searches.

Validation: `npm test`: 731 tests, 694 pass, 37 environment-gated skips, zero failures. New HTTP tests cover signup, existing accounts, pending requests in either direction, own-card scans, idempotency, invalid origin/CSRF, rotation/hidden cards, failed addition and retry. Lookup tests use the reported Felipe URL with and without tracking and never claim a real identity. Browser DOM checks of rendered synthetic owner/guest pages showed a visible main-nav card link, a 46px signup action and no horizontal overflow at 390px. Screenshot capture was blocked by the browser tool's configured workspace-root restriction; no screenshot evidence is claimed.

Live limitation: an anonymous exact name query for Felipe Contreras returned zero public results. This does not prove absence from LinkedIn or explain the clean-URL provider failure. A read-only GCP check failed with `Reauthentication failed. cannot prompt during non-interactive execution`; `gcloud auth login` is required and no reset time was supplied. `unlinked-nx6` tracks inspecting the live private adapter and verifying this case after authentication. No production identity was claimed, deployment made, or service restarted.
