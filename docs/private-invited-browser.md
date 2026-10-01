# Private invited-owner browser

This source is default off. No guest browser URL or production Ideaflow client is verified by these tests.
The runtime is separate from the deployed legacy Unlinked app.

An operator creates one expiring invitation using the Noos `unlinked-invite.mjs` CLI and keeps its mode-600 recovery bundle.
The guest opens the bundle's `/invite/<token>` URL and chooses **Create my private profile with Ideaflow**.
That action records an expiring, one-use browser intent and starts account choice with code, PKCE, state and nonce.
After signed ID-token verification against the configured issuer/client/JWKS, the trusted callback claims the invitation and reads back the same owner and private Noos principal before issuing the ordinary upload session.
An email address never selects, links or creates an owner.
The separate Unlinked profile does not link an existing OpenChat account.

Supply the initialized Noos callback-role provisioner and operational store inside the trusted private backend:

```js
await startPrivatePilot({
  baseUrl, login, getBackend, complete, port, dataMode,
  claimInvitation: provisioner.claim.bind(provisioner),
  resolveOwner: identity => store.resolveIdentity('unlinked', identity.issuer, identity.subject),
})
```

`login` is `createIdeaflowLogin` configured with the exact issuer, client and `/auth/callback/ideaflow` URL.
`provisioner` is Noos `InvitedOwnerProvisioner` with role `callback` and that same issuer/client; the operator capability is kept out of the browser runtime.
`getBackend` revalidates the active immutable owner/principal binding on each private operation.
These are private process capabilities, not HTTP endpoints accepting claimed identity fields.
The invitation secret remains in the browser intent/transaction store during login; it is absent from rendered forms, provider parameters, owner records and agent configuration.
Exclude `/invite/` request paths from proxy access logs and retain the operator bundle privately for recovery.

Expired/replayed browser intent, invalid state/nonce/signature/client, unknown ordinary sign-in, rejected/revoked invitation and owner-readback conflict issue no session.
Reopening the original invitation starts fresh authentication and can recover a lost claim response through Noos's exact-subject idempotent replay.
The graph's permanent revocation fence controls claims and subsequent resource/tool access.
Browser memory loss requires sign-in again; the owner mapping and archive receipts remain durable in Noos.

Upload then records one combined retention/OpenAI-processing consent, imports all accepted records through bounded journal chunks and one publication fence, and provides the existing private AI search and one-action scoped MCP setup.
The invitation action adds no second AI consent.

Focused source proof runs `node --test --test-concurrency=1 tests/private-browser.test.mjs tests/private-invitation-browser.test.mjs` with the locked root and MCP dependencies.
It performs signed synthetic OIDC over the real browser HTTP controller, while its claim store is synthetic.
Real Noos invitation transaction/race proof and final complete-network model/MCP/restore proof are separate required receipts, not inferred from this browser test.

Live delivery requires the stable HTTPS private origin, exact production Ideaflow client/callback, a dedicated persistent graph/assets target with paired backup/restore, private runtime secrets and operator-issued invitation.
Provider production changes remain an explicit Ideaflow production gate; no personal archive belongs in a synthetic runtime.
