# Private context on person pages

Since 0.6.3 (unlinked-9kk.4), a signed-in member sees **Your private context** on a person's page: the notes, relations, importance and catch-up cadence they keep about that person. Only the owner sees it.

The data is not stored by Unlinked. It is the owner's **Ideaflow people overlay** in Noos (`/api/overlay`, contract in Noos `docs/PEOPLE_OVERLAY.md`). OpenChat writes the same records, and so does any agent using the shared Ideaflow connector's private-people tools (`openchat__oc_*private*`). Unlinked reads them and does not write them. Noos owns every overlay rule, including name ambiguity, provenance, relation types, search and neighbourhood, so Unlinked has no copy of that logic.

This replaces the separate Unlinked `note` store sketched in the 2026-10-02 overlay design (§1, unlinked-47t). That design's UX states and privacy boundaries still apply.

## Where it appears

| Surface | How the person is matched |
|---|---|
| `/people/:id` (published profile), signed in | `unlinked:person:<id>`, plus `linkedin:in:<hash>` when the owner's own import contains the same person (`unlinked_lookup_contact` by `profileId`). |
| `/network/contacts/:connectionId` (one of the owner's own imported contacts) | `linkedin:in:<sha256(linkedinSlug())>` from the owner's row, plus `unlinked:person:<id>` when that person has a published profile. On `/network`, private rows without a published profile now link to this page. |

When two refs name separate overlay entities (they were never joined in Noos), both are shown. Unlinked never joins them.

Each entity shows:
- Notes, newest first, with a source label from provenance, such as "Added by Claude via your Ideaflow connector", "Added by you" or "· inferred". Records written before 2026-10-09 carry no provenance and show no label.
- Relations, worded from the person's side, with the other end linked where it is an Unlinked person: a published profile, or the owner's own contact page.
- Importance and catch-up (cadence, last contact, next or due).
- **Explore 2 hops**: the bounded neighbourhood (Noos limits it to 100 entities and 200 links).

The panel is a `<details>` that is open by default. The open or closed choice is kept per browser (`localStorage`). The empty state tells the owner how to add context: through their agent with the Ideaflow connector, or in OpenChat. Editing inside Unlinked is deferred.

States, as in the design: anonymous visitors get nothing at all, not even an empty shell. Signed-in members see a loading line, then `ready`, `empty` (distinct from a failure), `unavailable` ("Your private context is unavailable right now"), or `no_identity`. The public page never waits on the panel.

## Privacy boundaries

- The page HTML carries only an empty mount, `data-private-context="/api/private-context/…"`. The browser fetches the data separately with the session cookie:
  - `GET /api/private-context/people/:profileId`
  - `GET /api/private-context/contacts/:connectionId`
  - `GET /api/private-context/entities/:entityId/neighbourhood?depth=1|2`
- These endpoints answer:
  - Signed out: 401 with no data.
  - Not GET: 405.
  - Cross-site fetch (`Sec-Fetch-Site`): 403.
  - Another owner's contact or entity: 404, the same answer as missing.
  - Over 60 requests per minute per owner: 429.
- Every answer carries `Cache-Control: no-store, private`, `Vary: Cookie` and `Cross-Origin-Resource-Policy: same-origin`. The service worker never caches API responses.
- The panel script builds DOM with `textContent` only.
- Overlay data is never placed in public HTML, `/api/people*`, `/search-public`, the public projection, the published People index, the agent tools, or any model or AI-search input. `tests/private-context.test.mjs` checks this for anonymous visitors, another account, the public pages and APIs, and AI search.
- Answers carry no refs, overlay identity, issuer or subject. They contain names, text, labels and same-origin links only.

## Owner identity (the bridge)

An overlay owner is `sha256(issuer + "\n" + subject)` of the owner's verified Ideaflow sign-in. An Unlinked session holds only `{ownerId, userId}`.

The runtime recovers the identity by **reverse lookup** of the durable binding made at sign-in. This is the existing `identityForOwner` in `private-composition.mjs`, which messaging also uses. It matches `OperationalOwner` (active, same `userId`) with `OperationalIdentity` and checks `identityIssuer`/`identitySubject` agree. Only an identity from the runtime's own issuer (`IDEAFLOW_ISSUER`) is accepted. The result is cached in process for 5 minutes.

Reverse lookup was chosen over storing issuer and subject in the session for three reasons:
- Durable sessions restored after a restart work without a new sign-in.
- The session record and `UnlinkedSession` nodes stay unchanged.
- Authority stays with the binding, so a deactivated binding stops answering.

The runtime then signs a one-minute HS256 assertion for app `unlinked`, with the same claims as Noos `signOverlayAssertion`, and calls Noos server to server.

**Limitation:** OpenChat accounts that never linked an Ideaflow sign-in keep their overlay under OpenChat's fallback key (`https://chat.ideaflow.app/openchat-user` / OpenChat user id). Unlinked cannot see that overlay. Every Unlinked account signs in with Ideaflow ID. Once the same person links Ideaflow in OpenChat, OpenChat moves the fallback overlay to the Ideaflow key and it appears here.

## Export and deletion

- **Export** (`/export`): includes `ideaflowPrivateContext`, the owner's copy of their whole overlay (Noos `GET /export`), marked `deletedWithUnlinkedAccount: false`. If Noos cannot be read, the export carries `{error: 'private_context_unavailable'}` instead.
- **Delete everything** (`/delete-account`): does **not** delete the overlay. It belongs to the person's Ideaflow identity and is shared with OpenChat, so deleting an Unlinked account must not silently erase what they keep in OpenChat. The Settings copy says so and points to OpenChat or their agent. Noos `DELETE /api/overlay/owner` erases it all.
- **App-level erasure** of refs in the `unlinked:` prefix (`POST /purge-ref` with a purge assertion) is not wired up. A published profile that is removed leaves owners' own notes in place, under a ref that no longer resolves.

## Configuration

`runtime.env` (mode 600, never in the repo):

```
NOOS_OVERLAY_APP_UNLINKED_SECRET=<the same value noos_api holds; ≥ 32 characters>
# optional; default in shared-noos mode:
NOOS_OVERLAY_URL=http://noos_api:4000/api/overlay
```

Without the secret, or with one shorter than 32 characters, the feature is off. Pages show no panel and the endpoints answer 503 `{state:'unavailable'}`. The site keeps working. Noos releases copy their environment from the running `noos_api` container, so the Noos side survives releases unchanged.

## Not yet

- Editing in Unlinked.
- A per-row context strip on `/network`.
- The "My knowledge" browser from RELATIONSHIP-MEMORY.md.
- Search across the overlay in Unlinked.
- Purge-ref on profile removal.
