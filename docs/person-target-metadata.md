# Current owner-network person targets

`GET /api/agent/v1/person-targets?q=&cursor=&limit=` and the matching read-only
`unlinked_list_person_targets` tool expose at most 50 current own-network
connections per page with a published profile, exact active owner binding and
canonical Ideaflow identity. Names, emails and imported addresses never establish
account identity. Unclaimed people and ambiguous/inactive owners are omitted.

Existing read grants/provisioning supply authorization. Catalog8 adds the tool
within the original owner-network data boundary; catalogs1–7 remain immutable.
No write permission, secret, account, publication or conversation is created.
Revocation is revalidated after reads. Missing identity/block configuration fails
closed, without falling back to imported names or an owner credential.

The projection rereads current own-network evidence and active accepted requests
or invitations for accepted-member source rows. Historical OpenChat receipts are
not consulted. Member blocks apply both by account in either direction and by
blocked profile, including a block created before that profile had an account.
OpenChat must independently recheck its own discovery and blocks before resolving
these identities into inbox targets. Connected never implies chatted.

Responses contain only profileId, displayName, issuer/subject and connected; no
contact fields, request notes, message bodies or local owner IDs. The cursor pages
the own network and a page can contain no resolvable members. Clients must not
claim that one page is an exhaustive graph.

Focused tests: tests/person-targets.test.mjs, connections-dedupe-sort.test.mjs,
account-grant-provisioning.test.mjs and private-grants.test.mjs.
