import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { createKnownConnectionsReader, knownConnectionQuery } from '../src/utils/public-people/known-connections.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError, PRESENCE } from '../src/utils/public-people/reader.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { SEARCH_MODES } from '../src/utils/public-people/text-match.mjs'
import { ConnectionError } from './member-connections.mjs'
import { createConnectionActions } from './connection-actions.mjs'
import { ACCOUNT_WRITE_SCOPE, CURRENT_ACCOUNT_GRANT_VERSION, missingAccountGrantTools, scopeCoversPublic } from './account-grants.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const LINKEDIN_PROFILE = /^https:\/\/www\.linkedin\.com\/in\/[\w%-]+$/

// Typed error vocabulary shared by the HTTP agent API and the MCP tools.
// Codes are a stable contract (docs/agent-api.md): extend, never rename.
export const ACCOUNT_TOOL_ERROR_STATUS = Object.freeze({
  invalid_input: 400, cursor_invalid: 400, not_linked: 401, grant_revoked: 401,
  client_unauthorized: 403, scope_not_granted: 403, not_found: 404, degree_unproven: 409,
  result_too_large: 413, rate_limited: 429, upstream_unavailable: 503,
  // Connection-request write tools (grant catalog version 4, opt-in scope).
  not_a_member: 409, already_connected: 409, request_pending: 409, request_unavailable: 409, cooldown_active: 429,
})

export class AccountToolError extends Error {
  constructor(code, message) {
    if (!Object.hasOwn(ACCOUNT_TOOL_ERROR_STATUS, code)) throw new Error('account_tool_error_code_invalid')
    super(message ?? code)
    this.name = 'AccountToolError'
    this.code = code
    this.status = ACCOUNT_TOOL_ERROR_STATUS[code]
  }
}

export const ACCOUNT_TOOL_SCHEMAS = Object.freeze({
  unlinked_whoami: {},
  unlinked_list_people: {
    q: z.string().max(200).optional(), mode: z.enum(SEARCH_MODES).optional(), presence: z.enum(PRESENCE).optional(),
    cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(50).optional(),
  },
  unlinked_list_connections: {
    degree: z.union([z.literal(1), z.literal(2)]).optional(), q: z.string().max(256).optional(),
    cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).optional(),
  },
  unlinked_get_profile: { id: z.string().min(1).max(160), connectionsCursor: z.string().max(2048).optional() },
  unlinked_ai_search: {
    query: z.string().min(1).max(1024), scope: z.enum(['everyone', 'mine']).optional(),
    timeoutMs: z.number().int().min(1000).max(40000).optional(),
  },
  unlinked_search_network: {
    query: z.string().min(1).max(1024), degree: z.union([z.literal(1), z.literal(2)]).optional(),
    cursor: z.string().max(2048).optional(),
  },
  unlinked_search_everyone: { query: z.string().min(1).max(1024) },
  unlinked_list_connection_requests: { direction: z.enum(['received', 'sent']).optional() },
  unlinked_list_notifications: { limit: z.number().int().min(1).max(50).optional() },
  unlinked_send_connection_request: { profileId: z.string().min(1).max(160), note: z.string().max(300).optional() },
  unlinked_accept_connection_request: { id: z.string().min(1).max(64) },
  unlinked_ignore_connection_request: { id: z.string().min(1).max(64) },
  unlinked_withdraw_connection_request: { id: z.string().min(1).max(64) },
})

export const ACCOUNT_TOOL_DESCRIPTIONS = Object.freeze({
  unlinked_whoami: 'Return the authenticated grant owner: the stable Unlinked owner id, grant scope/version/tools, import count and confirmed legacy-profile anchor if any. Linkage is the grant itself — never email matching. No contact email/phone is returned.',
  unlinked_list_people: 'Deterministically list or lexically filter the published public People index; presence=member keeps people who joined, presence=shadow keeps imported profiles not on Unlinked yet. Paginated with an opaque cursor, at most 50 per page, with total and snapshot revision. Public fields only.',
  unlinked_list_connections: 'Deterministically list the owner’s connections. degree 1 includes owner-imported contacts (no legacy anchor required) plus recorded public first-degree paths when anchored; degree 2 returns only recorded public paths — never inferred — and fails typed degree_unproven without a confirmed anchor. Paginated, at most 50 per page, typed provenance per entry.',
  unlinked_get_profile: 'Read one published public profile by id with its public connections page. Returns typed not_found when no published profile has that id.',
  unlinked_list_connection_requests: 'Read-only: list the owner’s open member-to-member connection requests. direction "received" (default) lists requests waiting for the owner’s answer; "sent" lists requests the owner sent that are still pending. Names, public profile ids, optional notes and times only. Grants with the opt-in connections scope can answer and send requests with the connection-request write tools.',
  unlinked_list_notifications: 'Read-only: list the owner’s newest in-app notifications (connection requests received or accepted, invites accepted, people they know joining) with unseen/unread counts. Reading here does not mark anything seen or read.',
  unlinked_send_connection_request: 'Opt-in write tool. Send a connection request, as the owner, to the member behind a published profile id (presence member; imported shadows cannot be asked). Same rules and limits as pressing Connect on the site: one open request per pair, 50 new requests per day, a 21-day wait after withdrawing; asking someone who already asked the owner accepts their request. Optional note up to 300 characters. Returns status sent or accepted.',
  unlinked_accept_connection_request: 'Opt-in write tool. Accept a connection request the owner received (id from unlinked_list_connection_requests direction received). Connects both accounts.',
  unlinked_ignore_connection_request: 'Opt-in write tool. Ignore a connection request the owner received. Private: the sender is not told and still sees it as pending.',
  unlinked_withdraw_connection_request: 'Opt-in write tool. Withdraw a still-open connection request the owner sent (id from unlinked_list_connection_requests direction sent). The recipient’s notification is removed; asking the same person again waits 21 days.',
  unlinked_ai_search: 'Ask the AI about people. scope "mine" ranks only your own imported network; scope "everyone" ranks the published public People index and requires a public-scope grant. Owner role queries require supplied title evidence, omit domain-only matches and state unknown sector focus. Default scope is the widest the grant covers. AI-backed: may exceed 10s; set timeoutMs to bound it.',
})

const DETERMINISTIC_TOOLS = new Set(['unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_list_connection_requests', 'unlinked_list_notifications'])
export const WRITE_TOOLS = new Set(['unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request'])
// Request-model refusals, mapped onto the typed agent vocabulary.
const CONNECTION_FAILURES = Object.freeze({
  connection_not_member: ['not_a_member', 'That profile is not an Unlinked member yet (an imported profile), so it cannot be asked to connect.'],
  connection_self: ['invalid_input', 'That is the owner’s own profile.'],
  connection_exists: ['already_connected', 'The owner and this member are already connected.'],
  connection_pending: ['request_pending', 'A request between the owner and this member is already open.'],
  connection_cooldown: ['cooldown_active', 'The owner withdrew a request to this member recently; asking again waits 21 days.'],
  connection_rate_limited: ['rate_limited', 'The owner has sent 50 connection requests in the last day; retry tomorrow.'],
  connection_note_invalid: ['invalid_input', 'The note must be one paragraph of at most 300 characters.'],
  connection_not_found: ['not_found', 'No connection request with that id belongs to the owner in that direction.'],
  connection_unavailable: ['request_unavailable', 'That request is no longer open.'],
  connection_profile_not_found: ['not_found', 'No published public profile has that id.'],
})
const connectionFailure = code => new AccountToolError(...(CONNECTION_FAILURES[code] ?? ['upstream_unavailable', 'The connection request could not be completed; retry.']))
const iso = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : null

const opaqueCursor = (binding, offset) => Buffer.from(JSON.stringify({ binding, offset })).toString('base64url')
const cursorOffset = (cursor, binding, length) => {
  if (cursor === undefined) return 0
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.binding !== binding || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > length || Object.keys(value).length !== 2) throw new Error()
    return value.offset
  } catch { throw new AccountToolError('cursor_invalid', 'The cursor does not match the current listing; restart from the first page.') }
}

// One service instance backs both the hosted MCP tools and the HTTP agent API,
// so rate budgets are shared. Every tool result is grant-scoped, public-or-own
// data only: no contact email/phone, raw archives or credential URLs ever leave.
export function createAccountToolService({ getBackend, complete, readPublishedSnapshot, memberConnections, notifications, accountForProfile, ownProfileId, memberInvitations, limits = {} }) {
  if (typeof getBackend !== 'function') throw new Error('account_tool_service_configuration_required')
  const { deterministicPerMinute = 120, aiPerMinute = 20, aiPerDay = 2000, aiInFlight = 2, aiInFlightTotal = 8, writePerMinute = 20 } = limits
  // Write tools use the same rules as the site's Connect button.
  const connectionActions = memberConnections && typeof accountForProfile === 'function' && typeof readPublishedSnapshot === 'function'
    ? createConnectionActions({ memberConnections, accountForProfile, ownProfileId, memberInvitations, readPublishedSnapshot }) : null
  // Budgets are per grant owner, so one agent cannot starve other accounts;
  // a shared in-flight ceiling still bounds total concurrent provider spend.
  const budgets = new Map()
  let aiBusyTotal = 0
  const bucket = ownerId => {
    const now = Date.now(), day = Math.floor(now / 86400000)
    if (budgets.size > 5000) for (const [key, value] of budgets) if (value.aiDay !== day && now - value.window >= 60000 && !value.aiBusy) budgets.delete(key)
    let value = budgets.get(ownerId)
    if (!value) { value = { window: now, deterministic: 0, writeWindow: now, write: 0, aiWindow: now, ai: 0, aiDay: day, aiDayCount: 0, aiBusy: 0 }; budgets.set(ownerId, value) }
    return value
  }
  // Writes have their own small per-minute budget on top of the daily
  // request limit the request store enforces for site and agent alike.
  const admitWrite = ownerId => {
    const value = bucket(ownerId)
    if (Date.now() - value.writeWindow >= 60000) { value.writeWindow = Date.now(); value.write = 0 }
    if (++value.write > writePerMinute) throw new AccountToolError('rate_limited', 'Connection write budget is exhausted; retry within a minute.')
  }
  const admitDeterministic = ownerId => {
    const value = bucket(ownerId)
    if (Date.now() - value.window >= 60000) { value.window = Date.now(); value.deterministic = 0 }
    if (++value.deterministic > deterministicPerMinute) throw new AccountToolError('rate_limited', 'Deterministic tool budget is exhausted; retry within a minute.')
  }
  const admitAi = ownerId => {
    const value = bucket(ownerId), now = Date.now(), day = Math.floor(now / 86400000)
    if (now - value.aiWindow >= 60000) { value.aiWindow = now; value.ai = 0 }
    if (day !== value.aiDay) { value.aiDay = day; value.aiDayCount = 0 }
    if (value.ai >= aiPerMinute || value.aiDayCount >= aiPerDay || value.aiBusy >= aiInFlight || aiBusyTotal >= aiInFlightTotal) throw new AccountToolError('rate_limited', 'AI tool budget is exhausted; retry within a minute.')
    value.ai++; value.aiDayCount++; value.aiBusy++; aiBusyTotal++
    return () => { value.aiBusy--; aiBusyTotal-- }
  }

  const publicReader = pageSize => {
    if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
    const captured = { revision: null, total: null }
    const reader = createPublicPeopleReader({ pageSize, readPublishedSnapshot: async options => {
      const value = await readPublishedSnapshot(options)
      captured.revision = typeof value?.revision === 'string' ? value.revision : null
      captured.total = Array.isArray(value?.profiles) ? value.profiles.length : null
      return value
    } })
    return { reader, captured }
  }
  // With q/mode already schema-validated, a reader 400 under a supplied cursor
  // is a cursor problem; a post-snapshot failure under a supplied cursor is the
  // revision moving between pages. Both mean: restart from the first page.
  const readerFailure = (error, cursorSupplied, captured) => {
    if (error instanceof PublicPeopleReaderError && error.status === 400)
      return cursorSupplied
        ? new AccountToolError('cursor_invalid', 'The cursor does not match this listing; restart from the first page.')
        : new AccountToolError('invalid_input', 'The public People request was invalid (query or mode).')
    if (cursorSupplied && captured?.revision)
      return new AccountToolError('cursor_invalid', 'The published index revision changed; restart from the first page.')
    return new AccountToolError('upstream_unavailable', 'The published public People index is unavailable right now.')
  }

  const connectionEntry = row => {
    const recorded = row.provenance?.source === 'recovered-legacy-public-v1'
    const headline = typeof row.fields?.position === 'string' && row.fields.position ? { headline: row.fields.position.slice(0, 256) } : {}
    const company = typeof row.fields?.company === 'string' && row.fields.company ? { company: row.fields.company.slice(0, 256) } : {}
    const linkedinUrl = typeof row.subject === 'string' && LINKEDIN_PROFILE.test(row.subject) ? { linkedinUrl: row.subject } : {}
    return {
      id: row.id,
      name: [row.fields?.['first name'], row.fields?.['last name']].filter(Boolean).join(' ').slice(0, 256),
      ...headline, ...company, ...linkedinUrl,
      provenance: recorded
        ? { type: 'recorded_public_path', path: { fromId: row.provenance.fromId, toId: row.provenance.toId }, revision: row.provenance.revision }
        : { type: 'owner_import', importId: row.importId, rowId: row.rowId },
      visibility: recorded ? 'public' : 'owner_private',
    }
  }

  const owner = grant => ({ ownerId: grant.ownerId, userId: grant.userId })
  const requireConnections = () => { if (!connectionActions) throw new AccountToolError('upstream_unavailable', 'Connection requests are not available on this runtime.') }
  const answer = async (grant, id, work, status) => {
    requireConnections()
    try { await work(owner(grant), id) } catch (failure) { if (failure instanceof ConnectionError) throw connectionFailure(failure.code); throw failure }
    return { kind: 'unlinked_connection_request_update', id, status, visibility: 'owner_private' }
  }
  const tools = {
    async unlinked_send_connection_request(grant, { profileId, note }) {
      requireConnections()
      let outcome
      try { outcome = await connectionActions.send(owner(grant), { profileId, note }) }
      catch (failure) {
        if (failure instanceof ConnectionError) throw connectionFailure(failure.code)
        if (failure instanceof PublicPeopleReaderError) throw failure.status === 400 ? new AccountToolError('invalid_input', 'The profile id is not valid.') : new AccountToolError('upstream_unavailable', 'The published People index is unavailable right now.')
        throw failure
      }
      if (outcome.code !== 'sent' && outcome.code !== 'accepted') throw connectionFailure(outcome.code)
      return { kind: 'unlinked_connection_request_sent', status: outcome.code, profileId: outcome.profileId, ...(outcome.request?.id ? { id: outcome.request.id } : {}), visibility: 'owner_private' }
    },
    async unlinked_accept_connection_request(grant, { id }) { return answer(grant, id, (member, value) => memberConnections.respond(member, value, 'accept'), 'accepted') },
    async unlinked_ignore_connection_request(grant, { id }) { return answer(grant, id, (member, value) => memberConnections.respond(member, value, 'ignore'), 'ignored') },
    async unlinked_withdraw_connection_request(grant, { id }) { return answer(grant, id, (member, value) => memberConnections.withdraw(member, value), 'withdrawn') },
    async unlinked_list_connection_requests(grant, { direction = 'received' }) {
      if (!memberConnections) throw new AccountToolError('upstream_unavailable', 'Connection requests are not available on this runtime.')
      const rows = direction === 'sent' ? await memberConnections.sent(owner(grant)) : await memberConnections.received(owner(grant))
      return { kind: 'unlinked_connection_requests', direction, total: rows.length, visibility: 'owner_private',
        requests: rows.slice(0, 200).map(value => ({ id: value.id, direction: value.direction, status: value.status, name: value.name, ...(value.profileId ? { profileId: value.profileId } : {}), ...(value.note ? { note: value.note } : {}), createdAt: iso(value.createdAt) })) }
    },
    async unlinked_list_notifications(grant, { limit = 20 }) {
      if (!notifications) throw new AccountToolError('upstream_unavailable', 'Notifications are not available on this runtime.')
      const [items, counts] = await Promise.all([notifications.list(owner(grant), { limit }), notifications.counts(owner(grant))])
      return { kind: 'unlinked_notifications', unseen: counts.unseen, unread: counts.unread, visibility: 'owner_private',
        notifications: items.map(value => ({ id: value.id, kind: value.kind, actorName: value.actorName, ...(value.actorProfileId ? { actorProfileId: value.actorProfileId } : {}), createdAt: iso(value.createdAt), read: value.read })) }
    },
    async unlinked_whoami(grant) {
      const backend = await getBackend({ ownerId: grant.ownerId, userId: grant.userId })
      const importIds = typeof backend.listImportIds === 'function' ? await backend.listImportIds() : []
      let legacy = null
      if (typeof backend.readLegacyProfile === 'function') { try { legacy = await backend.readLegacyProfile() } catch { legacy = null } }
      // Only a grant missing tools its scope now has is told to update.
      const missing = missingAccountGrantTools(grant)
      return { kind: 'unlinked_whoami', ownerId: grant.ownerId,
        grant: { scope: grant.scope, version: grant.version ?? 1, tools: [...grant.tools],
          ...(missing.length ? { update: { currentVersion: CURRENT_ACCOUNT_GRANT_VERSION, missingTools: missing, how: 'This grant predates tools its scope now includes. The owner can regenerate the agent setup in Unlinked Settings, or disconnect and reconnect this app, to get them.' } } : {}) },
        importCount: Array.isArray(importIds) ? importIds.length : 0,
        legacyProfile: legacy ? { profileId: legacy.profileId, name: legacy.profile?.name ?? null, revision: legacy.revision } : null,
        publicIndexAvailable: typeof readPublishedSnapshot === 'function' }
    },
    async unlinked_list_people(grant, { q = '', mode = 'best', presence, cursor, limit = 50 }, signal) {
      const { reader, captured } = publicReader(limit)
      let result
      try { result = await reader.list({ query: q, mode, presence, cursor, signal }) } catch (error) { throw readerFailure(error, cursor !== undefined, captured) }
      return { kind: 'unlinked_list_people', revision: captured.revision, total: result.total ?? captured.total ?? result.profiles.length,
        ...(result.match ? { match: result.match } : {}), profiles: result.profiles,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}), visibility: 'public' }
    },
    async unlinked_get_profile(grant, { id, connectionsCursor }, signal) {
      const { reader, captured } = publicReader(50)
      let result
      try {
        result = await reader.profile({ id, cursor: connectionsCursor, signal })
        // A merged profile answers with the profile it was merged into.
        if (result?.moved) result = { ...(await reader.profile({ id: result.moved, signal })), movedFrom: id }
      } catch (error) { throw readerFailure(error, connectionsCursor !== undefined, captured) }
      if (!result?.profile) throw new AccountToolError('not_found', 'No published public profile has that id.')
      return { kind: 'unlinked_get_profile', revision: captured.revision, profile: result.profile, ...(result.movedFrom ? { movedFrom: result.movedFrom } : {}), visibility: 'public' }
    },
    async unlinked_list_connections(grant, { degree = 1, q = '', cursor, limit = 50 }, signal) {
      const owner = { ownerId: grant.ownerId, userId: grant.userId }
      if (degree === 2) {
        if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('degree_unproven', 'Second-degree connections require recorded public paths, and no published public index is configured.')
        try {
          const result = await createKnownConnectionsReader({ owner, getBackend, readPublishedSnapshot })({ degree: 2, query: q, cursor, signal, pageSize: limit })
          return { kind: 'unlinked_list_connections', degree: 2, revision: result.revision, anchorId: result.anchorId, total: result.total,
            connections: result.profiles.map((profile, index) => ({ ...profile,
              provenance: { type: 'recorded_public_path', path: result.paths[index], revision: result.revision }, visibility: 'public' })),
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
        } catch (error) {
          if (error instanceof AccountToolError) throw error
          if (error.message === 'known_connections_anchor_unavailable') throw new AccountToolError('degree_unproven', 'Second-degree requires a confirmed legacy profile anchor with recorded public paths; none is linked. Paths are never inferred.')
          if (error.message === 'known_connections_cursor_invalid') throw new AccountToolError('cursor_invalid', 'The cursor does not match the current listing; restart from the first page.')
          if (error.message === 'known_connections_input_invalid') throw new AccountToolError('invalid_input', 'The connections request was invalid (degree, query or cursor).')
          throw new AccountToolError('upstream_unavailable', 'Recorded public connection paths are unavailable right now.')
        }
      }
      // Degree 1 includes owner-imported contacts even without a confirmed
      // legacy anchor; anchored recorded public paths join the same listing.
      let network
      try { network = await createAccountNetwork({ owner, getBackend }).readNetwork(undefined, { signal }) }
      catch { throw new AccountToolError('upstream_unavailable', 'The owner network is unavailable right now.') }
      const normalized = q.normalize('NFKC').trim().toLowerCase()
      const rows = network.assertions.filter(row => row.category === 'connections').map(connectionEntry)
        .filter(row => !normalized || [row.name, row.headline, row.company].some(value => typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(normalized)))
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      const revision = hash(JSON.stringify(rows.map(row => row.id)))
      const binding = hash(JSON.stringify([grant.ownerId, 1, normalized, revision]))
      const offset = cursorOffset(cursor, binding, rows.length)
      const selected = rows.slice(offset, offset + limit)
      return { kind: 'unlinked_list_connections', degree: 1, revision, total: rows.length, connections: selected,
        ...(offset + selected.length < rows.length ? { nextCursor: opaqueCursor(binding, offset + selected.length) } : {}) }
    },
    async unlinked_ai_search(grant, { query, scope, timeoutMs = 40000 }, signal) {
      // Default to the widest scope the grant actually covers, so the natural
      // single-argument call works on every grant that includes the tool.
      scope ??= scopeCoversPublic(grant.scope) ? 'everyone' : 'mine'
      if (typeof complete !== 'function') throw new AccountToolError('upstream_unavailable', 'AI ranking is not configured.')
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
      if (scope === 'mine') {
        let result
        try { result = await createAccountNetwork({ owner: { ownerId: grant.ownerId, userId: grant.userId }, getBackend, complete }).search({ query, signal: combined }) }
        catch (error) { throw askFailure(error, combined) }
        return { kind: 'unlinked_ai_search', scope: 'mine', mode: result.mode, considered: result.considered, indexed: result.indexed,
          matches: result.matches.map(match => ({ assertionId: match.assertionId, sourceId: match.sourceId, rowId: match.rowId,
            name: [match.fields?.['first name'], match.fields?.['last name']].filter(Boolean).join(' ').slice(0, 256),
            ...(match.fields?.position ? { headline: match.fields.position } : {}), ...(match.fields?.company ? { company: match.fields.company } : {}),
            reason: match.reason, visibility: 'owner_private' })) }
      }
      if (!scopeCoversPublic(grant.scope)) throw new AccountToolError('scope_not_granted', 'This grant covers only the owner network; asking about everyone requires a public-scope grant.')
      if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
      let result
      try { result = await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal: combined }) }
      catch (error) { throw askFailure(error, combined) }
      return { kind: 'unlinked_ai_search', scope: 'everyone', mode: result.mode, revision: result.revision, considered: result.considered,
        lexicalMatches: result.lexicalMatches, modelCandidates: result.modelCandidates, matches: result.matches, visibility: 'public' }
    },
    // The two launch tools keep their exact names and result semantics; the
    // hosted MCP endpoint still serves them inline for old and new grants.
    async unlinked_search_network(grant, { query, degree, cursor }, signal) {
      const owner = { ownerId: grant.ownerId, userId: grant.userId }
      let connectionQuery
      try { connectionQuery = knownConnectionQuery(query, degree) }
      catch { throw new AccountToolError('invalid_input', 'The search request was invalid (query or degree).') }
      if (cursor !== undefined && !connectionQuery.degree) throw new AccountToolError('invalid_input', 'A cursor requires a degree-filtered connections query.')
      try {
        if (connectionQuery.degree) {
          if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('degree_unproven', 'Recorded public connection paths require the published public index.')
          // The HTTP contract caps pages at 50; offset cursors stay compatible
          // with the hosted MCP launch tool's historical 100-row pages.
          return await createKnownConnectionsReader({ owner, getBackend, readPublishedSnapshot })({ ...connectionQuery, cursor, signal, pageSize: 50 })
        }
        if (typeof complete !== 'function') throw new AccountToolError('upstream_unavailable', 'AI ranking is not configured.')
        return await createAccountNetwork({ owner, getBackend, complete }).search({ query, signal })
      } catch (error) {
        if (error instanceof AccountToolError) throw error
        if (error.message === 'known_connections_anchor_unavailable') throw new AccountToolError('degree_unproven', 'Recorded public paths require a confirmed legacy profile anchor; none is linked.')
        if (error.message === 'known_connections_cursor_invalid') throw new AccountToolError('cursor_invalid', 'The cursor does not match the current listing; restart from the first page.')
        if (error.message === 'known_connections_input_invalid') throw new AccountToolError('invalid_input', 'The search request was invalid (query, degree or cursor).')
        throw new AccountToolError('upstream_unavailable', 'The owner network search could not finish; retry.')
      }
    },
    async unlinked_search_everyone(grant, { query }, signal) {
      if (!scopeCoversPublic(grant.scope)) throw new AccountToolError('scope_not_granted', 'This grant covers only the owner network.')
      if (typeof readPublishedSnapshot !== 'function' || typeof complete !== 'function') throw new AccountToolError('upstream_unavailable', 'Public People search is not configured.')
      try { return await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal }) }
      catch (error) { throw askFailure(error, signal) }
    },
  }

  const askFailure = (error, signal) => {
    if (error instanceof AccountToolError) return error
    if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') return new AccountToolError('upstream_unavailable', 'AI ranking did not finish within the time budget; retry, raise timeoutMs, or use the deterministic listing tools.')
    if (/query_invalid|query_limit/.test(String(error?.message))) return new AccountToolError('invalid_input', 'The query was empty or too long.')
    if (/not_found/.test(String(error?.message))) return new AccountToolError('not_found', 'An import referenced by the search is no longer published.')
    return new AccountToolError('upstream_unavailable', 'AI ranking is unavailable right now; retry.')
  }

  // revalidate (when supplied) must re-authenticate the live grant and throw
  // AccountToolError('grant_revoked') on any mismatch; it runs before and after
  // the tool body so a mid-call revocation never returns data.
  async function call({ grant, name, input = {}, signal, revalidate }) {
    if (!grant || typeof grant.ownerId !== 'string' || typeof grant.userId !== 'string' || !Array.isArray(grant.tools)) throw new AccountToolError('grant_revoked', 'The grant is no longer valid.')
    if (!Object.hasOwn(tools, name)) throw new AccountToolError('not_found', 'Unknown tool.')
    if (!grant.tools.includes(name)) throw new AccountToolError('scope_not_granted', `This grant does not include ${name}.`)
    if (WRITE_TOOLS.has(name) && grant.scope !== ACCOUNT_WRITE_SCOPE) throw new AccountToolError('scope_not_granted', 'Connection actions require an explicit opt-in grant.')
    const parsed = z.object(ACCOUNT_TOOL_SCHEMAS[name]).strict().safeParse(input)
    if (!parsed.success) throw new AccountToolError('invalid_input', parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 512))
    const release = DETERMINISTIC_TOOLS.has(name) ? admitDeterministic(grant.ownerId) ?? null : WRITE_TOOLS.has(name) ? admitWrite(grant.ownerId) ?? null : admitAi(grant.ownerId)
    try {
      if (typeof revalidate === 'function') await revalidate()
      const result = await tools[name](grant, parsed.data, signal)
      // A write has already happened by now; only reads are withheld when the
      // grant was revoked mid-call, so a landed write is never reported as failed.
      if (typeof revalidate === 'function' && !WRITE_TOOLS.has(name)) await revalidate()
      const text = JSON.stringify(result)
      if (Buffer.byteLength(text) > 1024 * 1024) throw new AccountToolError('result_too_large', 'The result exceeded 1 MiB; narrow the query or lower the page size.')
      return { result, text }
    } finally { release?.() }
  }

  return { call }
}
