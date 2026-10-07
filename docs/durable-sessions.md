# Durable Sessions

Browser sessions for the private pilot are backed by Neo4j (`sessionStore`), so members stay signed in across runtime restarts and deployments.

Sessions expire thirty days after creation; sign-out removes the current session, and account deletion removes the owner’s sessions. A deployment without a durable `sessionStore` loses sessions on restart.

## Design

- Sessions live primarily in an in-memory Map in `private-browser.mjs` for synchronous lookups during requests.
- When an unknown cookie is seen, the handler reads the durable store and restores it into the memory cache.
- The cookie value itself is never stored; we store only the SHA-256 hash.
- Recorded fields: `ownerId`, `userId`, `accountLabel`, `displayName`, `csrf`, `expiresAt`, `createdAt`.
- Occasionally, the memory cache runs a prune against the database to remove expired sessions.

## Storage
The durable storage is implemented via `createNeo4jSessionStore` mapped to the `UnlinkedSession` nodes in Neo4j, while a `createMemorySessionStore` variant provides isolated test semantics.