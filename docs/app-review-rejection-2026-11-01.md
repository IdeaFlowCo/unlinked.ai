# App Review rejection remediation — unlinked-9e7z

Apple reviewed submission `9346cea3-df14-4e6e-a18c-a0fea994832f`, iOS 1.0.0 (1), on October 30, 2026. Jacob authorized the fixes and resubmission on November 1.

## Account deletion (5.1.1(v))

The account deletion instructions and shared Ideaflow ID boundary are owned by [Help, support and legal links](support-and-legal.md); the shared OpenChat overlay boundary is in [Private context](private-context.md#export-and-deletion). Regression coverage is in `tests/account-data.test.mjs`.

## Listing and mainland China (Guideline 5)

App Store Connect app `6821198719`, version resource `0e7a6367-a01a-4395-85b1-f96a8f4ba604`:

- Description now says **connect your own AI agents through MCP**, preserving network and agent search benefits and relevant keywords. It no longer names ChatGPT as an example client. Apple sign-in is included accurately.
- Removed the old technical iPad screenshot. Five iPhone and three iPad screenshots remain.
- Mainland China (`CHN`) availability is off; all other 174 territories remain enabled. Readback verified that only CHN changed. This uses Apple's offered distribution remedy because the live app uses OpenAI search; removing a brand name alone would not suppress that functionality. A future mainland release needs a separately verified functional and compliance plan.

## Submission gate

Do not claim the resubmission is complete until App Store Connect confirms it. Apple specifically requested a screen recording on a **physical device** showing account creation or demo sign-in, navigation to deletion, and initiation through completion. Attach it to App Review Information and mention it in Review Notes. A simulator recording is not equivalent. A new native binary is not inherently required for these server-rendered fixes; the current SwiftUI shell loads the updated live site.

Evidence and App Store Connect before/after receipts are maintained in the originating session's `unlinked-rejection-20261101` directory. The existing crash-monitor owner handles Telegram and rejection monitoring, with future remediation and submission actions held for human approval.
