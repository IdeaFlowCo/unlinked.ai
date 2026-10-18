# Help, support and legal links

Unlinked follows Ideaflow, Inc.'s company policies. App Store review needs a
public support page, reachable policies and a way for anyone to contact us
(beads `unlinked-ac9.4`).

| Address | Answer |
|---|---|
| `/support` | Public **Help & support** page, with or without a session (`renderSupport` in `mcp-server/private-onboarding-views.mjs`, served by `mcp-server/public-discovery.mjs`). It is the App Store Support URL. |
| `/privacy`, `/privacy-policy` | `302` to `https://www.ideaflow.io/privacy-policy` |
| `/terms`, `/terms-of-service` | `302` to `https://www.ideaflow.io/terms-of-service` |
| `/contact`, `/help` | `302` to `/support` |

None of these answer 401, read an owner or start the automatic sign-in hop.

The support page covers: contact (`support@ideaflow.app`, the brand-wide
inbox that forwards to the operators), the public feedback board
(`https://worldissuetracker.com/tracker/unlinked-ai`), how to delete an
account (Settings → Your data → Delete everything…, anchored at
`/settings#your-data`), how to report people or messages, how a person can
have an imported profile about them removed, the community rules (no
tolerance for objectionable content or abusive users; reports reviewed
within 24 hours) and the two policies.

Links to the policies also appear in every page footer (Support, Privacy,
Terms), in Settings (**Help & legal**), in the Me menu (**Help & support**)
and as a terms line beside every sign-in step (landing, `/join`, "Sign in to
continue"). Change the addresses in one place: `SUPPORT_EMAIL`,
`FEEDBACK_URL`, `PRIVACY_URL` and `TERMS_URL` in
`mcp-server/private-onboarding-views.mjs`. Tests:
`tests/support-and-legal.test.mjs`.
