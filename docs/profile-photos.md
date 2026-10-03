# Profile photos

People profile pages, People list rows, connection rows, company pages, the
member's own profile and the member card (`/card`, `/scan` My card) show an
operator-published profile photo when one exists, and the initials otherwise.
Photos are an operator-published set from an offline operator source — never
member uploads and never fetched by the runtime.

## Serving

- `GET`/`HEAD /people/<id>/photo` (`mcp-server/private-browser.mjs`) answers
  only exact lowercase legacy profile uuids that are in the live photo set;
  everything else is `404` with `no-store`. No session is needed (the profile
  itself is public) and the route runs before any session or graph work, with
  its own site-wide bound (6000/min, 32 in flight, then `429`).
- Responses carry the sniffed `Content-Type` (`image/jpeg`, `image/png` or
  `image/webp`), `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy: same-origin` and a content `ETag`
  (`If-None-Match` answers `304`).
- Pages link `/people/<id>/photo?v=<first 16 hex of the sha256>`. That exact URL
  is `public, max-age=31536000, immutable`; any other URL for the photo is
  `public, max-age=300`. A new photo gets a new `v`, so pages never show a stale
  one longer than the 30-second pointer refresh.
- The page CSP is unchanged: `img-src 'self'` already allows same-origin images.
- Public summaries from the People reader carry `photo` (that URL) when one is
  published (`createPublicPeopleReader({ photoFor })`), so `/api/people`,
  `/api/people/<id>` and `/api/companies/<name>` include it too. Views accept
  `photo` only in that exact grammar (`PHOTO_URL`); anything else renders
  initials. The `<img>` alt text is the person's name; no inline styles.
- Ingress: both nginx variants keep `Cache-Control: no-store` on every response
  except `^/people/[^/]+/photo$`, where the runtime's header passes through (a
  `map` gives `add_header` an empty value there, which nginx omits).

## Storage

Under the runtime's existing read-write `assets` bind mount, so no Compose
change and the set is included in every cold-pair backup:

```
$R/assets/profile-photos.public/      mode 700 (the dot keeps it outside every owner-asset key grammar)
  blobs/<sha256>                       mode 600, immutable image bytes (deduplicated across sets)
  manifests/<sha256>.json              mode 600, { kind, version: 1, photos: { <id>: { sha256, type, bytes } } }
  current.json                         mode 600, { kind, manifest, history: [up to 20 older manifests], publishedAt }
```

Image bytes never go into Neo4j. The runtime re-reads `current.json` at most
every 30 seconds (`createProfilePhotoStore` in `mcp-server/profile-photos.mjs`),
verifies the manifest hash and validates the whole manifest; a broken pointer
keeps the last good set, an absent one means no photos. Every served blob is
checked for size, sha256 and magic bytes before it is sent.

## Precedence hook

`createProfilePhotoStore({ hidden })` takes `hidden(id) => boolean`. It is the
place for a future member "hide my photo" choice: returning `true` removes the
photo from every page and makes the route answer `404`. No setting exists yet;
`mcp-server/private-composition.mjs` passes none.

## Publishing

`mcp-server/publish-profile-photos.mjs` is an offline operator tool with the
same posture as `publish-enrichment-people.mjs`: fixed root
`/srv/unlinked-private-guest-pilot-20261001`, operator-owned private files, no
symlinks, plan by default, `--execute` writes an audit receipt.

Source directory layout (flat, nothing else in it):

```
<batch>/                                       mode 700, owned by the operator
  <legacy profile uuid>.jpg|.jpeg|.png|.webp   mode 600, owned by the operator, 12 bytes to 2 MiB
```

- Names must match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$`.
  Any other entry (sidecar, subdirectory, symlink, uppercase id, two files for
  one id) fails the whole run. The extension is not trusted: the type comes from
  the JPEG/PNG/WebP magic bytes, and anything else fails.
- Up to 20,000 photos. The batch is the complete set: ids missing from it lose
  their photo, so publish everything that should be live.
- Ids not in the published People snapshot (the `recovered-legacy-public-v1`
  dataset, read from the graph) are left out and counted in the plan/receipt
  (`unknownIds`, `unknownSample`). Plan mode checks this whenever
  `NOOS_PRIVATE_PASSWORD` is set, which it always is inside the runtime.
- `--execute` writes new blobs (temp file, fsync, rename), the manifest, then
  swaps `current.json` by rename and fsyncs the directory; it reads every photo
  back the way the runtime does before writing
  `audit/profile-photos-<ms>-<rand>.json`. Re-publishing the live set is a no-op
  (`UNCHANGED_NO_WRITES`).

### Host commands

Run as the operator account that owns `$R`, after a release containing this
code is live. The runtime container's rootfs is read-only, so the batch goes
under `$R/runtime` (mounted read-only into the container) and the tool runs
there with `docker exec`.

```sh
# From the machine holding the batch (flat directory as above):
gcloud compute scp --recurse --project=lightsail-migration --zone=us-central1-a ./profile-photos-<batch> noos:~/profile-photos-<batch>

# On the host:
R=/srv/unlinked-private-guest-pilot-20261001
RT=unlinked-private-guest-pilot-20261001-runtime
B=$R/runtime/profile-photo-sources/<batch>
install -d -m 700 $R/runtime/profile-photo-sources $B
find ~/profile-photos-<batch> -maxdepth 1 -type f -exec install -m 600 {} $B/ \;
rm -rf ~/profile-photos-<batch>
df -h /                                   # photos also land in every later cold-pair backup

sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/publish-profile-photos.mjs $B $R            # plan: counts, types, unknownIds, manifestSha256
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/publish-profile-photos.mjs $B $R --execute  # publish + receipt
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/publish-profile-photos.mjs --status $R      # live manifest, history, count
```

No restart is needed; pages pick the set up within 30 seconds. Check a page:
`curl -sI "https://www.unlinked.ai/people/<id>/photo"` should be `200` with an
image type. The batch directory can be removed after a successful publish.

### Rollback

```sh
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/publish-profile-photos.mjs --revoke $R            # plan: which manifest comes back
sudo -n docker exec $RT node $R/runtime/unlinked/mcp-server/publish-profile-photos.mjs --revoke $R --execute
```

Revoke points `current.json` at the previous manifest (or removes it, so no
photos, when there was none) and writes a receipt. Blobs and manifests are
never deleted by the tool, so repeated revokes walk back through up to 20 sets.
Removing photos from pages entirely without the tool: move
`$R/assets/profile-photos.public/current.json` aside.

## Rollout note

This change touches `deploy/private-pilot/nginx.conf` and
`nginx.canonical.conf` (the Cache-Control map). The release directory must be
built from this packet's files with `nginx.canonical.conf` copied over
`nginx.conf`, as for every canonical release. Without the new ingress config the
feature still works, but nginx adds `no-store` to photos so browsers refetch
them on every page.
