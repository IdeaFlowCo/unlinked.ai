# Private invited-owner browser

This source is default off. No guest browser URL or production Ideaflow client is verified by these tests.
The runtime is separate from the deployed legacy Unlinked app.

An operator creates one expiring invitation using the Noos `unlinked-invite.mjs` CLI and keeps its mode-600 recovery bundle.
The guest opens the bundle's `/invite/<token>` URL and chooses **Continue with Ideaflow**.
That action records an expiring, one-use browser intent and starts fresh Ideaflow authentication with code, PKCE, state, nonce and `prompt=login`.
After signed ID-token verification against the configured issuer/client/JWKS, Unlinked renders the verified issuer/subject or authenticated IdP email for explicit confirmation before the trusted backend claims the invitation and reads back the same owner and private Noos principal.
The guest can restart authentication to use another account or cancel before any owner is created.
An email address never selects, links or creates an owner.
The separate Unlinked profile does not link an existing OpenChat account.

Supply the initialized Noos callback-role provisioner and operational store inside the trusted private backend:

```js
await startPrivatePilot({
  baseUrl, login, getBackend, complete, port, networkMode, dataMode,
  claimInvitation: provisioner.claim.bind(provisioner),
  resolveOwner: identity => store.resolveIdentity('unlinked', identity.issuer, identity.subject),
})
```

`login` is `createIdeaflowLogin` configured with the exact issuer, client and `/auth/callback/ideaflow` URL; invited browser flows require its explicit HTTPS `authorizationOrigin` so the landing page can allow only that provider in `form-action`.
`networkMode` defaults to host loopback; the deployment launcher is the only path that selects the exact `isolated-container` topology.
`provisioner` is Noos `InvitedOwnerProvisioner` with role `callback` and that same issuer/client; the operator capability is kept out of the browser runtime.
`getBackend` revalidates the active immutable owner/principal binding on each private operation.
These are private process capabilities, not HTTP endpoints accepting claimed identity fields.
The invitation secret remains in the browser intent/transaction/confirmation stores during login; it is absent from rendered forms, provider parameters, owner records and agent configuration.
Exclude `/invite/` request paths from proxy access logs and retain the operator bundle privately for recovery.
Private ingress and the browser handler use `Referrer-Policy: strict-origin`: navigation keeps the Origin header for the CSRF gate while exposing only the HTTPS origin, not the invitation path or query, as a referrer. Non-invitation forms keep `form-action 'self'`.

Expired/replayed browser intent, invalid state/nonce/signature/client, unknown ordinary sign-in, rejected/revoked invitation and owner-readback conflict issue no session.
Reopening the original invitation starts fresh authentication and can recover a lost claim response through Noos's exact-subject idempotent replay.
The graph's permanent revocation fence controls claims and subsequent resource/tool access.
Browser memory loss requires sign-in again; the owner mapping and archive receipts remain durable in Noos.

After sign-in, upload, consent, publication, AI search and scoped MCP setup follow the [staging contract](private-noos-staging.md#scoped-search-and-browser).
The invitation action adds no second AI consent.

Focused source proof runs `node --test --test-concurrency=1 tests/private-browser.test.mjs tests/private-invitation-browser.test.mjs` with the locked root and MCP dependencies.
It performs signed synthetic OIDC over the real browser HTTP controller, while its claim store is synthetic.
Real Noos invitation transaction/race proof and final complete-network model/MCP/restore proof are separate required receipts, not inferred from this browser test.

Live delivery requires the stable HTTPS private origin, exact production Ideaflow client/callback, a dedicated persistent graph/assets target with paired backup/restore, private runtime secrets and operator-issued invitation.
Provider production changes remain an explicit Ideaflow production gate; no personal archive belongs in a synthetic runtime.
