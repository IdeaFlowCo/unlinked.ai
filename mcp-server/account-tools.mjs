import { EXPORT_FIELDS } from './bulk-export-format.mjs'
export const INTERNAL_BULK_READ = Symbol('unlinked-internal-bulk-read')
import { reportIndexError } from '../src/utils/public-people/error-report.mjs'
import { INVESTOR_TOOLS, INVESTOR_MUTATING, INVESTOR_SCHEMAS, INVESTOR_DESCRIPTIONS } from './investor-tools.mjs'
import { searchActivity } from './search-activity.mjs'
import { requestDiagnostic } from './request-diagnostics.mjs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createAccountNetwork, withSearchDeadline } from '../src/utils/private-import/account-network.mjs'
import { createKnownConnectionsReader, knownConnectionQuery } from '../src/utils/public-people/known-connections.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError, PRESENCE, ENRICHMENT_STATUS } from '../src/utils/public-people/reader.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { SEARCH_MODES } from '../src/utils/public-people/text-match.mjs'
import { UNLINKED_PROFILE_ORIGIN } from '../src/utils/openchat-profile-context.mjs'
import { ConnectionError } from './member-connections.mjs'
import { createConnectionActions } from './connection-actions.mjs'
import { PRIVATE_NOTES_TOOLS, scopeAllowsConnectionActions, scopeAllowsPrivateNotes, scopeCoversPublic } from './account-grants.mjs'
import { PRIVATE_NOTES_DESCRIPTIONS, PRIVATE_NOTES_MUTATING, PRIVATE_NOTES_SCHEMAS, createPrivateNotesTools } from './private-notes-tools.mjs'
import { linkedinRefHash, linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { linkedinUrl as canonicalLinkedinUrl } from '../src/utils/private-import/archive.mjs'
import { CONNECTION_SORTS, PUBLIC_LIST_SORTS, orderNetwork, validTimestamp } from '../src/utils/network-order.mjs'
import { groupConnectionRows, rowSlug, rowPublicTarget, usableProfileId } from './connection-identity.mjs'
import { contactFingerprint } from './contact-enrichment.mjs'

const profileStatus = profile => ({ presence: profile?.presence ?? 'unknown', enrichmentStatus: profile?.enrichmentStatus ?? 'unknown', detailLevel: profile?.detailLevel ?? 'unknown' })

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
  // Private people notes & relations (grant catalog version 7, separate permission).
  ambiguous_name: 409, identity_unavailable: 409,
  import_busy: 409, identity_conflict: 409,
})

// unlinked_search_network's text-first path: name the AI fallback's own
// failures (missing provider, spent time budget) instead of a generic outage.
export function networkSearchFailure(error, signal) {
  if (error instanceof AccountToolError) return error
  if (error?.message === 'private_search_configuration_required') return new AccountToolError('upstream_unavailable', 'No literal name, company or title match, and AI ranking is not configured.')
  if (error?.message === 'private_search_query_limit') return new AccountToolError('invalid_input', 'The query was empty or too long.')
  if (!signal?.aborted && error?.name === 'TimeoutError') return new AccountToolError('upstream_unavailable', 'No literal name, company or title match, and AI ranking did not finish within 20 s; search a name, company or title word, or page through unlinked_list_connections.')
  return error
}

export class AccountToolError extends Error {
  // details: extra owner-only fields for the error body (ambiguous_name candidates).
  constructor(code, message, details) {
    if (!Object.hasOwn(ACCOUNT_TOOL_ERROR_STATUS, code)) throw new Error('account_tool_error_code_invalid')
    super(message ?? code)
    this.name = 'AccountToolError'
    this.code = code
    this.status = ACCOUNT_TOOL_ERROR_STATUS[code]
    if (details) this.details = details
  }
}

// unlinked_list_connections grouping (unlinked-tto.1): `person` (default) folds
// rows with exact identity evidence into one entry with sources[]; `none`
// returns one row per source record, as before.
export const CONNECTION_GROUPINGS = Object.freeze(['person', 'none'])

export const ACCOUNT_TOOL_SCHEMAS = Object.freeze({
  unlinked_export_network: { inline: z.boolean().optional(), scope: z.enum(['mine','everyone','all','list']).optional(), query: z.string().max(200).optional(), listId: z.string().max(100).optional(), format: z.enum(['csv','json','jsonl']).optional(), detail: z.enum(['headline','summary','full']).optional(), ids: z.array(z.string().min(1).max(160)).max(10000).optional(), fields: z.array(z.enum(EXPORT_FIELDS)).max(EXPORT_FIELDS.length).optional(), presence: z.enum(['member','legacy','shadow']).optional(), mode: z.enum(['best','exact']).optional(), ...Object.fromEntries(['degree','location','company','pastCompany','title','school','industry'].map(key=>[key,z.string().max(120).optional()])) },
  unlinked_whoami: {},
  unlinked_list_person_targets: { q: z.string().max(100).optional(), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).optional() },
  unlinked_list_people: {
    q: z.string().max(200).optional(), mode: z.enum(SEARCH_MODES).optional(), presence: z.enum(PRESENCE).optional(), enrichmentStatus: z.enum(ENRICHMENT_STATUS).optional(),
    sort: z.enum(PUBLIC_LIST_SORTS).optional(),
    cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(50).optional(),
  },
  unlinked_list_connections: {
    degree: z.union([z.literal(1), z.literal(2)]).optional(), q: z.string().max(256).optional(),
    sort: z.enum(CONNECTION_SORTS).optional(), grouping: z.enum(CONNECTION_GROUPINGS).optional(),
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
  unlinked_lookup_contact: {
    connectionId: z.string().min(1).max(128).optional(), linkedinUrl: z.string().min(1).max(512).optional(),
    profileId: z.string().min(1).max(160).optional(), refHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100).optional(),
  },
  ...PRIVATE_NOTES_SCHEMAS,
  ...INVESTOR_SCHEMAS,
})

export const ACCOUNT_TOOL_DESCRIPTIONS = Object.freeze({
  unlinked_export_network: 'Set inline:true to query every matching row in one response when it fits; a real response-size limit returns an explicit incomplete preview plus a full download link. Prepare one complete authenticated download of all matching people, with no manual cursor walking or row/page truncation. scope mine exports your network; list + listId private:<id> or saved:<id> exports a current owned list. Verified accounts with public scope may use everyone or all (own + published). Choose csv for a spreadsheet, json for structured records, or jsonl for streaming; detail headline, summary or full, or select fields. Full includes available profile evidence; private list notes require private-notes scope. Returns browser and bearer-authenticated API links without embedding a token. Fetch the API link with the SAME account bearer in one request; use the browser link while signed in for manual download. The response streams every internal page and confirms completion. No public sharing or privilege expansion.',
  unlinked_list_person_targets: 'Read-only current owner-network members with proven active Ideaflow identity, for cross-app person targets. Exact published-profile ownership only; no names/email guesses, contact details, messages, relationship assertions, account creation or sends. Connected does not mean chatted. Cursor pages the current own network, including imported connections.',
  unlinked_whoami: 'Return the authenticated grant owner: the stable Unlinked owner id, grant scope/version/tools, import count and confirmed legacy-profile anchor if any. Linkage is the grant itself — never email matching. No contact email/phone is returned.',
  unlinked_list_people: 'Deterministically list or lexically filter the published public People index; presence=member keeps people who joined, presence=legacy keeps recovered accounts awaiting claim, presence=shadow keeps imported profiles without a recovered account. enrichmentStatus filters enriched, not_recorded (no current published enrichment evidence; not proof of never enriched), or unknown. Enrichment is independent of detailLevel and membership. sort: best (default: relevance with q, else stored name order), name (A–Z by first letter or number, ignoring leading emoji/punctuation, accents and case), name-desc, raw (Unicode code-point order of the name as written). Paginated with an opaque cursor bound to the query and sort, at most 50 per page, with total and snapshot revision. Public fields only.',
  unlinked_list_connections: 'Deterministically list the owner’s connections. degree 1 includes owner-imported contacts (no legacy anchor required) plus recorded public first-degree paths when anchored; degree 2 returns only recorded public paths — never inferred — and fails typed degree_unproven without a confirmed anchor. Degree 1 groups one entry per person (grouping "person", default) when records share exact identity evidence — the same published profile (merges followed) or the same LinkedIn address, never a name — with sources[] listing every underlying record (provenance, visibility) and top-level fields from the owner import; total counts people. grouping "none" returns one row per source record. Each entry includes public presence, enrichmentStatus and detailLevel, or unknown when public evidence is unavailable. sort: name (default; A–Z from the first letter or number, ignoring leading emoji/punctuation, accents and case — names are shown exactly as written), raw (Unicode code-point order), name-desc, connected (most recently connected first), imported (most recently imported first), company. Paginated, at most 50 per page; the cursor is bound to q, sort and grouping.',
  unlinked_get_profile: 'Read one published public profile by id (or a profile handle) with its public connections page. Profiles with a readable address include their handle and public url. Returns typed not_found when no published profile has that id.',
  unlinked_list_connection_requests: 'Read-only: list the owner’s open member-to-member connection requests. direction "received" (default) lists requests waiting for the owner’s answer; "sent" lists requests the owner sent that are still pending. Names, public profile ids, optional notes and times only. Grants with the opt-in connections scope can answer and send requests with the connection-request write tools.',
  unlinked_list_notifications: 'Read-only: list the owner’s newest in-app notifications (connection requests received or accepted, invites accepted, people they know joining) with unseen/unread counts. Reading here does not mark anything seen or read.',
  unlinked_send_connection_request: 'Opt-in write tool. Send a connection request, as the owner, to the member behind a published profile id (presence member; imported shadows cannot be asked). Same rules and limits as pressing Connect on the site: one open request per pair, 50 new requests per day, a 21-day wait after withdrawing; asking someone who already asked the owner accepts their request. Optional note up to 300 characters. Returns status sent or accepted.',
  unlinked_accept_connection_request: 'Opt-in write tool. Accept a connection request the owner received (id from unlinked_list_connection_requests direction received). Connects both accounts.',
  unlinked_ignore_connection_request: 'Opt-in write tool. Ignore a connection request the owner received. Private: the sender is not told and still sees it as pending.',
  unlinked_withdraw_connection_request: 'Opt-in write tool. Withdraw a still-open connection request the owner sent (id from unlinked_list_connection_requests direction sent). The recipient’s notification is removed; asking the same person again waits 21 days.',
  unlinked_lookup_contact: 'Read-only, owner-scoped: resolve one of the owner’s own contacts without paging. Give exactly one of connectionId (an id from unlinked_list_connections), linkedinUrl (a linkedin.com/in/ address), profileId (a published profile id) or refHashes (up to 100 linkedinRefHash values). Returns name, headline, company, the owner connectionId when the owner imported the person, linkedinRefHash (SHA-256 of the canonical LinkedIn slug, the private-graph key `linkedin:in:<hash>`) and publishedProfileId when the same person has a published Unlinked profile. Also returns presence, enrichmentStatus and detailLevel, each unknown if public evidence is unavailable. Never returns another owner’s imports; typed not_found when nothing matches.',
  unlinked_ai_search: 'Ask the AI about people. scope "mine" ranks only your own imported network; scope "everyone" ranks the published public People index and requires a public-scope grant. Owner role queries require supplied title evidence, omit domain-only matches and give short conversational reasons stating unknown sector focus. Default scope is the widest the grant covers. AI-backed: may exceed 10s; set timeoutMs to bound it.',
  ...PRIVATE_NOTES_DESCRIPTIONS,
  ...INVESTOR_DESCRIPTIONS,
})

const DETERMINISTIC_TOOLS = new Set(['unlinked_export_network', 'unlinked_list_person_targets', ...PRIVATE_NOTES_TOOLS, ...INVESTOR_TOOLS, 'unlinked_lookup_contact', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_list_connection_requests', 'unlinked_list_notifications'])
export const WRITE_TOOLS = new Set(['unlinked_send_connection_request', 'unlinked_accept_connection_request', 'unlinked_ignore_connection_request', 'unlinked_withdraw_connection_request'])
// Every tool that changes something: connection writes plus private-notes writes.
export const MUTATING_TOOLS = new Set([...WRITE_TOOLS, ...PRIVATE_NOTES_MUTATING, ...INVESTOR_MUTATING])
const PRIVATE_NOTES_TOOL_SET = new Set([...PRIVATE_NOTES_TOOLS, ...INVESTOR_TOOLS])
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
  // A block between the two accounts (docs/report-and-block.md); which side blocked is not said.
  connection_not_available: ['request_unavailable', 'This member cannot be asked to connect.'],
  connection_profile_not_found: ['not_found', 'No published public profile has that id.'],
})
const connectionFailure = code => new AccountToolError(...(CONNECTION_FAILURES[code] ?? ['upstream_unavailable', 'The connection request could not be completed; retry.']))
const iso = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : null
// rowSlug, rowPublicTarget and usableProfileId live in connection-identity.mjs,
// shared with the private browser's contact rows.
// A user-supplied LinkedIn profile address, with or without scheme.
const suppliedSlug = value => {
  const text = value.normalize('NFKC').trim()
  return linkedinSlug(canonicalLinkedinUrl(/^https?:\/\//i.test(text) ? text.replace(/^http:/i, 'https:') : `https://${text}`))
}

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
// `overlay` + `identityFor` (optional) enable the private-notes tools: the Noos
// people overlay client (private-context.mjs) and the owner identity bridge.
// lookup_contact failures name the step that failed and the index's fixed
// reason (request diagnostics failure_stage / index_failure); no message or data.
const stageOf = (error, stage) => Object.assign(error, { stage })
const indexReasonOf = (stage, error) => {
  if (typeof error?.reason === 'string') return error.reason
  if (error instanceof PublicPeopleReaderError) return error.status === 400 ? 'input_invalid' : 'reader_refused'
  // Not from the reader at all: this tool's own candidate code threw.
  reportIndexError('tool', stage, error)
  return 'tool_exception'
}
const indexFailure = (stage, error) => Object.assign(new AccountToolError('upstream_unavailable', 'The published public People index is unavailable right now.'), { stage, indexReason: indexReasonOf(stage, error) })
export function createAccountToolService({ exportManifest, isVerified = async () => false, getBackend, complete, readPublishedSnapshot, profileHandles, memberConnections, memberBlocks, connectionIdentityForOwner, notifications, accountForProfile, ownProfileId, memberInvitations, lookupSlug, contactAddresses, overlay, identityFor, coordination, limits = {} }) {
  if (typeof getBackend !== 'function') throw new Error('account_tool_service_configuration_required')
  const { deterministicPerMinute = 120, aiPerMinute = 20, aiPerDay = 2000, aiInFlight = 2, aiInFlightTotal = 8, writePerMinute = 20 } = limits
  // An owner's whole network read (every published import, the legacy link,
  // invites, accepted requests) takes 15-25 s on large accounts: longer than the
  // gateway or OpenChat waits, so every lookup_contact timed out (2026-11-10).
  // list_connections and lookup_contact share one read per owner while younger
  // than `networkFreshMs`. The read runs detached from any one caller, so an
  // abandoned call still warms the next; any mutating tool by that owner drops
  // it. Same contract as the signed-in browser cache (private-browser.mjs).
  // list_person_targets keeps its own live read on purpose.
  const networkFreshMs = limits.networkFreshMs ?? 30000
  if (!Number.isSafeInteger(networkFreshMs) || networkFreshMs < 0 || networkFreshMs > 300000) throw new Error('account_tool_service_configuration_required')
  const networkCache = new Map(), NETWORK_CACHE_CAPACITY = 64
  // `served.held` tells the caller the read predates this call (lookup_contact re-reads once on a miss).
  const ownerNetwork = async (who, signal, served = {}) => {
    signal?.throwIfAborted()
    served.held = false
    const now = Date.now()
    for (const [key, held] of networkCache) if (!held.pending && now - held.at >= networkFreshMs) networkCache.delete(key)
    const key = `${who.ownerId}\u0000${who.userId}`
    let entry = networkFreshMs > 0 ? networkCache.get(key) : null
    // Reuse fails closed: the owner's import list must still be readable (an
    // outage throws here) and unchanged, so a new or removed import is never
    // served from a held read. One cheap call instead of the whole network.
    if (entry && !entry.pending) {
      const ids = await (await getBackend(who)).listImportIds()
      const held = entry.value.imports ?? []
      if (!Array.isArray(ids) || ids.length !== held.length || [...ids].sort().some((id, index) => id !== [...held].sort()[index])) { networkCache.delete(key); entry = null }
    }
    if (!entry) {
      entry = { pending: null, value: null, at: 0 }
      entry.pending = createAccountNetwork({ owner: who, getBackend }).readNetwork().then(
        value => { Object.assign(entry, { value, at: Date.now(), pending: null }); if (networkFreshMs === 0) networkCache.delete(key); return value },
        error => { if (networkCache.get(key) === entry) networkCache.delete(key); throw error })
      entry.pending.catch(() => {})
      networkCache.delete(key); networkCache.set(key, entry)
      while (networkCache.size > NETWORK_CACHE_CAPACITY) networkCache.delete(networkCache.keys().next().value)
    }
    served.held = !entry.pending && entry.at > 0
    const work = entry.pending ?? Promise.resolve(entry.value)
    if (!signal) return work
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('aborted'))
      signal.addEventListener('abort', abort, { once: true })
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  const dropOwnerNetwork = ownerId => { for (const key of [...networkCache.keys()]) if (key.startsWith(ownerId + '\u0000')) networkCache.delete(key) }
  // Write tools use the same rules as the site's Connect button.
  const connectionActions = memberConnections && typeof accountForProfile === 'function' && typeof readPublishedSnapshot === 'function'
    ? createConnectionActions({ memberConnections, accountForProfile, ownProfileId, memberInvitations, readPublishedSnapshot }) : null
  // Suspended profile ids (docs/profile-suspension.md), from the owner's backend; fails closed.
  const suspendedIds = async grant => { const backend = await getBackend({ ownerId: grant.ownerId, userId: grant.userId }); return (typeof backend.readSuppressions === 'function' ? (await backend.readSuppressions())?.ids : null) ?? new Set() }
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

  // A published profile carries its handle and public address (docs/profile-handles.md).
  const handleOf = profile => profile?.id ? profileHandles?.handleFor(profile.id) ?? null : null
  const withHandle = (profile, address = false) => {
    const handle = handleOf(profile)
    return handle ? { ...profile, handle, ...(address ? { url: `${UNLINKED_PROFILE_ORIGIN}/people/${encodeURIComponent(handle)}` } : {}) } : profile
  }
  const publicReader = (pageSize, reuse = false) => {
    if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
    const captured = { revision: null, total: null }
    const observe = async options => {
      const value = await readPublishedSnapshot(options)
      captured.revision = typeof value?.revision === 'string' ? value.revision : null
      captured.total = Array.isArray(value?.profiles) ? value.profiles.length : null
      return value
    }
    // Share the source's compiled index: building it blocks the event loop for
    // seconds on the full public index, and this runs on every profile view
    // (private context) and agent call.
    observe.compiledSource = readPublishedSnapshot
    const reader = createPublicPeopleReader({ pageSize, readPublishedSnapshot: observe, reuse })
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

  // One person from their grouped source records, primary (owner import) first:
  // top-level fields come from the primary, then the first source that has
  // them; dates are the earliest known (a re-import never looks newer).
  const personEntry = members => {
    const [primary] = members, first = key => members.map(member => member.entry[key]).find(Boolean)
    const earliest = key => members.map(member => validTimestamp(member.row[key])).filter(Boolean).reduce((a, b) => Math.min(a, b), Infinity)
    const connectedAt = earliest('connectedAt'), importedAt = earliest('importedAt')
    const refHash = members.map(member => linkedinRefHash(rowSlug(member.row))).find(Boolean)
    const profile = members.map(member => member.published).find(Boolean)
    const fields = Object.fromEntries(['headline', 'company', 'linkedinUrl'].map(key => [key, first(key)]).filter(([, value]) => value))
    const sources = members.map(({ entry }) => ({ id: entry.id, name: entry.name, provenance: entry.provenance, visibility: entry.visibility }))
    return {
      id: primary.entry.id, connectedAt: Number.isFinite(connectedAt) ? connectedAt : undefined, importedAt: Number.isFinite(importedAt) ? importedAt : undefined, searchable: members.map(member => member.entry),
      entry: {
        id: primary.entry.id, name: primary.entry.name || first('name') || '', ...fields, ...profileStatus(profile),
        ...(profile?.id ? { publishedProfileId: profile.id } : {}), ...(refHash ? { linkedinRefHash: refHash } : {}),
        ...(Number.isFinite(connectedAt) ? { connectedAt: iso(connectedAt) } : {}), ...(Number.isFinite(importedAt) ? { importedAt: iso(importedAt) } : {}),
        provenance: primary.entry.provenance,
        visibility: sources.some(source => source.visibility === 'owner_private') ? 'owner_private' : 'public',
        sources,
      },
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
    async unlinked_export_network(grant, input, signal, revalidate) {
      if (typeof exportManifest !== 'function') throw new AccountToolError('upstream_unavailable', 'Complete downloads are unavailable on this runtime.')
      try { return await exportManifest(grant, input, signal, async()=>{
        const current=await revalidate?.()
        if(current&&(['everyone','all'].includes(input.scope)&&!scopeCoversPublic(current.scope)||input.scope==='list'&&!scopeAllowsPrivateNotes(current.scope)))throw new AccountToolError('scope_not_granted','The download permission was removed.')
      }) } catch(error) { throw new AccountToolError(error.code ?? 'upstream_unavailable', error.code ? error.message : 'The download could not be prepared.') }
    },
    async unlinked_send_connection_request(grant, { profileId, note }, signal, revalidate) {
      requireConnections()
      let outcome
      try { outcome = await connectionActions.send(owner(grant), { profileId, note, beforeWrite: revalidate }) }
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
      const suspended = await suspendedIds(grant)
      const rows = (direction === 'sent' ? await memberConnections.sent(owner(grant)) : await memberConnections.received(owner(grant))).filter(row => !suspended.has(row.profileId))
      return { kind: 'unlinked_connection_requests', direction, total: rows.length, visibility: 'owner_private',
        requests: rows.slice(0, 200).map(value => ({ id: value.id, direction: value.direction, status: value.status, name: value.name, ...(value.profileId ? { profileId: value.profileId } : {}), ...(value.note ? { note: value.note } : {}), createdAt: iso(value.createdAt) })) }
    },
    async unlinked_list_notifications(grant, { limit = 20 }) {
      if (!notifications) throw new AccountToolError('upstream_unavailable', 'Notifications are not available on this runtime.')
      const suspended = await suspendedIds(grant)
      const [all, counts] = await Promise.all([notifications.list(owner(grant), { limit }), notifications.counts(owner(grant))])
      const items = all.filter(value => !suspended.has(value.actorProfileId))
      return { kind: 'unlinked_notifications', unseen: counts.unseen, unread: counts.unread, visibility: 'owner_private',
        notifications: items.map(value => ({ id: value.id, kind: value.kind, actorName: value.actorName, ...(value.actorProfileId ? { actorProfileId: value.actorProfileId } : {}), createdAt: iso(value.createdAt), read: value.read })) }
    },
    async unlinked_whoami(grant) {
      const backend = await getBackend({ ownerId: grant.ownerId, userId: grant.userId })
      const importIds = typeof backend.listImportIds === 'function' ? await backend.listImportIds() : []
      // A recovered legacy archive is an import too: its rows are listed as
      // owner_import connections, so it counts here (it is not an uploaded job).
      let recoveredArchive = false
      if (typeof backend.readLegacyFiles === 'function') { try { recoveredArchive = Boolean(await backend.readLegacyFiles()) } catch { recoveredArchive = false } }
      let legacy = null
      if (typeof backend.readLegacyProfile === 'function') { try { legacy = await backend.readLegacyProfile() } catch { legacy = null } }
      // A suspended profile is hidden from its own account too (docs/profile-suspension.md); fail closed.
      if (legacy && typeof readPublishedSnapshot === 'function') { try { if (await createPublicPeopleReader({ readPublishedSnapshot }).suspended({ id: legacy.profileId })) legacy = null } catch { legacy = null } }
      return { kind: 'unlinked_whoami', ownerId: grant.ownerId,
        grant: { scope: grant.scope, version: grant.version ?? 1, tools: [...grant.tools],
          toolRefresh: 'New tools within enabled permissions use this same key: refresh tools/list if your client caches tools; never replace the key for this. Switch “Send and manage connection requests” and “Private people notes & relations” for this API key in Settings; OAuth apps reconnect to consent to additional permissions. Messaging is not part of Unlinked keys: use the shared Ideaflow connector (https://id.ideaflow.app/mcp) with OpenChat permission.' },
        importCount: (Array.isArray(importIds) ? importIds.length : 0) + Number(recoveredArchive),
        imports: { uploaded: Array.isArray(importIds) ? importIds.length : 0, recoveredArchive },
        legacyProfile: legacy ? { profileId: legacy.profileId, name: legacy.profile?.name ?? null, revision: legacy.revision } : null,
        publicIndexAvailable: typeof readPublishedSnapshot === 'function' }
    },
    // Members' public addresses use their handle (docs/profile-handles.md).
    async unlinked_list_people(grant, { q = '', mode = 'best', presence, enrichmentStatus, sort = 'best', cursor, limit = 50 }, signal) {
      const { reader, captured } = publicReader(limit)
      let result
      try { result = await reader.list({ query: q, mode, presence, enrichmentStatus, sort, cursor, signal }) } catch (error) { throw readerFailure(error, cursor !== undefined, captured) }
      return { kind: 'unlinked_list_people', revision: captured.revision, ...(sort !== 'best' ? { sort } : {}), total: result.total ?? captured.total ?? result.profiles.length,
        ...(result.match ? { match: result.match } : {}), profiles: result.profiles.map(withHandle),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}), visibility: 'public' }
    },
    async unlinked_get_profile(grant, { id, connectionsCursor }, signal) {
      const { reader, captured } = publicReader(50)
      // The member's own agent sees connections as the member would (docs/connection-privacy.md).
      const mine = typeof ownProfileId === 'function' ? await ownProfileId(owner(grant)).catch(() => null) : null
      const viewer = { signedIn: true, ...(mine ? { id: mine } : {}) }
      let result
      try {
        result = await reader.profile({ id: profileHandles?.resolve(id)?.profileId ?? id, cursor: connectionsCursor, signal, viewer })
        // A merged profile answers with the profile it was merged into.
        if (result?.moved) result = { ...(await reader.profile({ id: result.moved, signal, viewer })), movedFrom: id }
      } catch (error) { throw readerFailure(error, connectionsCursor !== undefined, captured) }
      // A handle names only a member's profile.
      if (!result?.profile || (profileHandles?.resolve(id) && !handleOf(result.profile))) throw new AccountToolError('not_found', 'No published public profile has that id.')
      return { kind: 'unlinked_get_profile', revision: captured.revision, profile: withHandle(result.profile, true), ...(result.movedFrom ? { movedFrom: result.movedFrom } : {}), visibility: 'public' }
    },
    async unlinked_list_person_targets(grant, { q = '', cursor, limit = 50 }, signal) {
      if (typeof connectionIdentityForOwner !== 'function' || typeof accountForProfile !== 'function' || !memberBlocks)
        throw new AccountToolError('upstream_unavailable', 'Person identity metadata is not configured.')
      const listing = await tools.unlinked_list_connections(grant, { q, cursor, limit, degree: 1, sort: 'connected', grouping: 'person' }, signal)
      const viewer = owner(grant), people = []
      const hidden = await memberBlocks.hidden(viewer)
      // Re-read live source evidence so a completed/ongoing connection removal
      // cannot be revived by a cached public path or an acceptance receipt.
      const network = await createAccountNetwork({ owner: viewer, getBackend }).readNetwork(undefined, { signal })
      const sources = new Map(network.assertions.filter(row => row.category === 'connections').map(row => [row.id, row]))
      const [accepted, invited] = await Promise.all([
        memberConnections ? memberConnections.connections(viewer) : [],
        memberInvitations ? memberInvitations.connections(viewer) : [],
      ])
      const same = (a, b) => a.ownerId === b.ownerId && a.userId === b.userId
      for (const entry of listing.connections) {
        signal?.throwIfAborted()
        if (!entry.publishedProfileId || hidden.profiles.has(entry.publishedProfileId)) continue
        const target = await accountForProfile(entry.publishedProfileId)
        if (!target || same(viewer, target) || await memberBlocks.between(viewer, target)) continue
        const rows = entry.sources.map(source => sources.get(source.id)).filter(Boolean)
        const imported = rows.some(row => !['unlinked-connection', 'unlinked-invite'].includes(row.provenance?.source))
        if (!imported && ![...accepted, ...invited].some(value => same(value.other, target))) continue
        const identity = await connectionIdentityForOwner(target)
        if (!identity || identity.issuer !== 'https://id.ideaflow.app/api/auth' || typeof identity.subject !== 'string'
          || !identity.subject || identity.subject.length > 512 || /[\x00-\x1f\x7f]/.test(identity.subject)) continue
        people.push({ profileId: entry.publishedProfileId, displayName: entry.name,
          identity: { issuer: identity.issuer, subject: identity.subject }, connected: true })
      }
      return { kind: 'unlinked_person_targets', people, ...(listing.nextCursor ? { nextCursor: listing.nextCursor } : {}) }
    },
    async unlinked_list_connections(grant, { degree = 1, q = '', sort = 'name', grouping = 'person', cursor, limit = 50 }, signal) {
      const owner = { ownerId: grant.ownerId, userId: grant.userId }
      if (degree === 2) {
        if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('degree_unproven', 'Second-degree connections require recorded public paths, and no published public index is configured.')
        try {
          // Second-degree entries are already one published profile each.
          const result = await createKnownConnectionsReader({ owner, getBackend, readPublishedSnapshot })({ degree: 2, query: q, sort, cursor, signal, pageSize: limit })
          return { kind: 'unlinked_list_connections', degree: 2, sort, revision: result.revision, anchorId: result.anchorId, total: result.total,
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
      try { network = await ownerNetwork(owner, signal) }
      catch { throw new AccountToolError('upstream_unavailable', 'The owner network is unavailable right now.') }
      const normalized = q.normalize('NFKC').trim().toLowerCase()
      const rows = network.assertions.filter(row => row.category === 'connections'), entries = rows.map(connectionEntry)
      const identityReader = typeof readPublishedSnapshot === 'function' ? createPublicPeopleReader({ readPublishedSnapshot, reuse: true }) : null
      const addressLookups = new Map()
      const publishedSlug = slug => {
        if (!addressLookups.has(slug)) addressLookups.set(slug, (async () => {
          if (identityReader) {
            try {
              const match = await identityReader.lookupLinkedin({ address: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`, signal })
              if (match) return match.id
            } catch {}
          }
          return typeof lookupSlug === 'function' ? lookupSlug(slug) : null
        })())
        return addressLookups.get(slug)
      }
      const { groups, published } = await groupConnectionRows(rows, entries, { lookupSlug: publishedSlug, lookup: identityReader ? ids => identityReader.lookup({ ids, signal }) : null })
      let listed
      if (grouping === 'none') listed = entries.map((entry, index) => ({ id: entry.id, entry: { ...entry, ...profileStatus(published[index]) }, searchable: [entry], connectedAt: validTimestamp(rows[index].connectedAt), importedAt: validTimestamp(rows[index].importedAt) }))
      else {
        listed = groups.map(indexes => personEntry(indexes.map(index => ({ row: rows[index], entry: entries[index], published: published[index] }))))
      }
      const rowsMatching = listed.filter(item => !normalized || item.searchable.some(entry => [entry.name, entry.headline, entry.company].some(value => typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(normalized))))
      const ordered = orderNetwork(rowsMatching, sort, item => item.entry.name, item => item.entry.company ?? '')
      const revision = hash(JSON.stringify(ordered.map(item => grouping === 'none' ? item.id : [item.id, ...item.entry.sources.map(source => source.id)])))
      const binding = hash(JSON.stringify([grant.ownerId, 1, normalized, revision, sort, grouping]))
      const offset = cursorOffset(cursor, binding, ordered.length)
      const selected = ordered.slice(offset, offset + limit).map(item => item.entry)
      return { kind: 'unlinked_list_connections', degree: 1, grouping, sort, revision, total: ordered.length, connections: selected,
        ...(offset + selected.length < ordered.length ? { nextCursor: opaqueCursor(binding, offset + selected.length) } : {}) }
    },
    // A miss against a held read re-reads live once, so a just-added contact is
    // never reported missing; removals show within networkFreshMs, as in the browser.
    async unlinked_lookup_contact(grant, input, signal) {
      const served = {}
      try { return await lookupContactOnce(grant, input, signal, served) }
      catch (error) {
        if (error?.code !== 'not_found' || !served.held) throw error
        dropOwnerNetwork(grant.ownerId)
        return lookupContactOnce(grant, input, signal, {})
      }
    },
    async unlinked_lookup_contact_once(grant, input, signal, served) {
      const modes = ['connectionId', 'linkedinUrl', 'profileId', 'refHashes'].filter(key => input[key] !== undefined)
      if (modes.length !== 1) throw new AccountToolError('invalid_input', 'Give exactly one of connectionId, linkedinUrl, profileId or refHashes.')
      const mode = modes[0]
      let wantedSlug = null
      if (mode === 'linkedinUrl') {
        wantedSlug = suppliedSlug(input.linkedinUrl)
        if (!wantedSlug) throw new AccountToolError('invalid_input', 'linkedinUrl must be a LinkedIn profile address, like https://www.linkedin.com/in/their-name.')
      }
      const reader = typeof readPublishedSnapshot === 'function' ? publicReader(50, true).reader : null
      // The published profile for a profileId lookup (merged ids resolve to the survivor).
      let published = null
      if (mode === 'profileId') {
        if (!reader) throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
        try { published = (await reader.lookup({ ids: [input.profileId], signal })).get(input.profileId) ?? null }
        catch (error) { throw error instanceof PublicPeopleReaderError && error.status === 400 ? new AccountToolError('not_found', 'No published public profile has that id.') : indexFailure('index_profile_lookup', error) }
        if (!published) throw new AccountToolError('not_found', 'No published public profile has that id.')
      }
      // The owner's own connection rows; never anyone else's.
      let rows
      try { rows = (await ownerNetwork(owner(grant), signal, served)).assertions.filter(row => row.category === 'connections') }
      catch { throw stageOf(new AccountToolError('upstream_unavailable', 'The owner network is unavailable right now.'), 'owner_network') }
      // A row without its own LinkedIn address uses the one the owner attached
      // to that contact privately (contact enrichment), so the owner's private
      // card can be keyed linkedin:in:<hash>. Only the hash leaves this tool.
      let attached = new Map()
      if (typeof contactAddresses === 'function') { try { attached = await contactAddresses(owner(grant)) } catch { throw stageOf(new AccountToolError('upstream_unavailable', 'The owner contact addresses are unavailable right now.'), 'contact_addresses') } }
      const privateSlug = row => { const value = attached.get(row.id); return value && value.fingerprint === contactFingerprint(row) ? rowSlug({ fields: { url: value.address } }) : null }
      const ordered = rows.map(row => ({ row, entry: connectionEntry(row), slug: rowSlug(row) ?? privateSlug(row) }))
        .sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id))
      // Each candidate row's published identity evidence.
      const publishedFor = async candidates => {
        if (!reader || !candidates.length) return candidates.map(() => [])
        try {
          await reader.lookup({ ids: [], signal })
          // One row whose id or address the index refuses as malformed (e.g. a
          // LinkedIn export slug it cannot parse) has no published evidence; it
          // must not fail every lookup for the owner (outage of 2026-11-10).
          const evidence = async read => { try { return await read() } catch (error) { if (error instanceof PublicPeopleReaderError && error.status === 400) return null; throw error } }
          return await Promise.all(candidates.map(async candidate => {
            const target = usableProfileId(rowPublicTarget(candidate.row))
            const explicit = target ? await evidence(async () => (await reader.lookup({ ids: [target], signal })).get(target)) : null
            const byAddress = candidate.slug ? await evidence(() => reader.lookupLinkedin({ address: `https://www.linkedin.com/in/${encodeURIComponent(candidate.slug)}`, signal })) : null
            return [...new Map([explicit, byAddress].filter(Boolean).map(summary => [summary.id, summary])).values()]
          }))
        } catch (error) { throw indexFailure('index_published_lookup', error) }
      }
      const contactOf = async (candidate, summary) => {
        const sourceRef = linkedinRefHash(candidate.slug)
        let publicRef = null
        if (summary) {
          try { publicRef = await reader.linkedinRef({ id: summary.id, signal }) }
          catch (error) { throw indexFailure('index_linkedin_ref', error) }
        }
        return { ...profileStatus(summary), connectionId: candidate.entry.id, name: candidate.entry.name,
          ...(candidate.entry.headline ? { headline: candidate.entry.headline } : {}), ...(candidate.entry.company ? { company: candidate.entry.company } : {}),
          linkedinRefHash: publicRef ?? sourceRef, ...(sourceRef && publicRef && sourceRef !== publicRef ? { sourceLinkedinRefHash: sourceRef } : {}),
          publishedProfileId: summary?.id ?? null, provenance: candidate.entry.provenance }
      }
      if (mode === 'refHashes') {
        const wanted = new Set(input.refHashes), grouped = new Map()
        for (const candidate of ordered) {
          const value = linkedinRefHash(candidate.slug)
          if (value && wanted.has(value)) {
            if (!grouped.has(value)) grouped.set(value, [])
            grouped.get(value).push(candidate)
          }
        }
        const picked = [...grouped.values()].map(candidates => candidates[0])
        const summaries = await publishedFor(picked)
        return { kind: 'unlinked_lookup_contact', contacts: await Promise.all(picked.map(async (candidate, index) => {
          const hash = linkedinRefHash(candidate.slug), ids = [...new Set(grouped.get(hash).map(value => value.entry.id))].sort()
          return { ...await contactOf(candidate, summaries[index][0] ?? null), linkedinRefHash: hash, ...(ids.length > 1 ? { connectionIds: ids } : {}) }
        })), visibility: 'owner_private' }
      }
      let candidate = null
      if (mode === 'linkedinUrl' && reader) {
        try { published = await reader.lookupLinkedin({ address: input.linkedinUrl, signal }) }
        catch (error) { throw indexFailure('index_refhash_lookup', error) }
      }
      if (mode === 'connectionId') candidate = ordered.find(value => value.entry.id === input.connectionId) ?? null
      else if (mode === 'linkedinUrl' && !published) candidate = ordered.find(value => value.slug === wantedSlug) ?? null
      if (!published && !candidate) {
        if (mode === 'linkedinUrl' && !reader) throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
        throw new AccountToolError('not_found', mode === 'connectionId' ? 'No connection of the owner has that id.' : 'Neither the owner’s contacts nor a published profile have that LinkedIn address.')
      }
      const summaries = await publishedFor(ordered)
      let refs = new Map(), targetRef = null
      try {
        if (published) targetRef = await reader.linkedinRef({ id: published.id, signal })
        const ids = [...new Set(summaries.flat().map(summary => summary.id))]
        refs = new Map(await Promise.all(ids.map(async id => [id, await reader.linkedinRef({ id, signal })])))
      } catch { throw new AccountToolError('upstream_unavailable', 'The published public People index is unavailable right now.') }
      const parents = ordered.map((_, index) => index), byKey = new Map()
      const root = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index] } return index }
      for (let index = 0; index < ordered.length; index++) {
        const source = linkedinRefHash(ordered[index].slug)
        const keys = [...(source ? [`h:${source}`] : []), ...summaries[index].flatMap(summary => [`p:${summary.id}`, ...(refs.get(summary.id) ? [`h:${refs.get(summary.id)}`] : [])])]
        for (const key of keys) {
          const other = byKey.get(key)
          if (other === undefined) byKey.set(key, index)
          else { const left = root(index), right = root(other); if (left !== right) parents[left] = right }
        }
      }
      let start = candidate ? ordered.indexOf(candidate) : byKey.get(`p:${published.id}`)
      if (start === undefined && targetRef) start = byKey.get(`h:${targetRef}`)
      const indexes = start === undefined || start < 0 ? [] : ordered.flatMap((_, index) => root(index) === root(start) ? [index] : [])
      const publicIds = new Set(published ? [published.id] : []), hashes = new Set(targetRef ? [targetRef] : [])
      const related = new Map()
      for (const index of indexes) {
        const source = linkedinRefHash(ordered[index].slug)
        if (source) hashes.add(source)
        for (const summary of summaries[index]) {
          const publicRef = refs.get(summary.id)
          publicIds.add(summary.id)
          if (publicRef) hashes.add(publicRef)
          const key = publicRef ? `h:${publicRef}` : `p:${summary.id}`
          if (!related.has(key)) related.set(key, summary.id)
        }
      }
      if (published) related.set(targetRef ? `h:${targetRef}` : `p:${published.id}`, published.id)
      try {
        for (const id of related.values()) for (const relatedId of await reader.linkedinProfileIds({ id, signal })) publicIds.add(relatedId)
      } catch { throw new AccountToolError('upstream_unavailable', 'The published public People index is unavailable right now.') }
      const primary = candidate ?? (indexes.length ? ordered[indexes[0]] : null)
      if (primary) {
        const preferredIndex = ordered.indexOf(primary)
        const summary = summaries[preferredIndex][0] ?? indexes.flatMap(index => summaries[index])[0] ?? published
        const contact = await contactOf(primary, summary)
        const sourceLinkedinRefHashes = [...hashes].filter(hash => hash !== contact.linkedinRefHash)
        const publishedProfileIds = [...publicIds].filter(id => id !== contact.publishedProfileId)
        return { kind: 'unlinked_lookup_contact', publicReconciliationComplete: Boolean(reader), contact: { ...contact, ...(sourceLinkedinRefHashes.length ? { sourceLinkedinRefHashes } : {}), ...(publishedProfileIds.length ? { publishedProfileIds } : {}) }, visibility: 'owner_private' }
      }
      return { kind: 'unlinked_lookup_contact', publicReconciliationComplete: true, contact: { ...profileStatus(published), connectionId: null, name: published.name, ...(published.headline ? { headline: published.headline } : {}), linkedinRefHash: targetRef, publishedProfileId: published.id, ...([...publicIds].some(id => id !== published.id) ? { publishedProfileIds: [...publicIds].filter(id => id !== published.id) } : {}) }, visibility: 'public' }
    },
    async unlinked_ai_search(grant, { query, scope, timeoutMs = 40000 }, signal) {
      // Default to the widest scope the grant actually covers, so the natural
      // single-argument call works on every grant that includes the tool.
      scope ??= scopeCoversPublic(grant.scope) ? 'everyone' : 'mine'
      if (typeof complete !== 'function') throw new AccountToolError('upstream_unavailable', 'AI ranking is not configured.')
      if (scope === 'mine') {
        let result
        try { result = await createAccountNetwork({ owner: { ownerId: grant.ownerId, userId: grant.userId }, getBackend, complete }).askNetwork({ query, signal, budgetMs: timeoutMs }) }
        catch (error) { throw askFailure(error, signal) }
        return { kind: 'unlinked_ai_search', scope: 'mine', mode: result.mode, considered: result.considered, indexed: result.indexed, ...(result.partial ? { partial: true } : {}),
          matches: result.matches.map(match => ({ assertionId: match.assertionId, sourceId: match.sourceId, rowId: match.rowId,
            name: [match.fields?.['first name'], match.fields?.['last name']].filter(Boolean).join(' ').slice(0, 256),
            ...(match.fields?.position ? { headline: match.fields.position } : {}), ...(match.fields?.company ? { company: match.fields.company } : {}),
            reason: match.reason, visibility: 'owner_private' })) }
      }
      if (!scopeCoversPublic(grant.scope)) throw new AccountToolError('scope_not_granted', 'This grant covers only the owner network; asking about everyone requires a public-scope grant.')
      if (typeof readPublishedSnapshot !== 'function') throw new AccountToolError('upstream_unavailable', 'The published public People index is not configured.')
      let result
      try { result = await withSearchDeadline({ signal, budgetMs: timeoutMs, label: 'ai_search' }, ({ deadline }) => createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal: deadline })) }
      catch (error) { throw askFailure(error, signal) }
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
        return await createAccountNetwork({ owner, getBackend, complete }).searchNetwork({ query, signal })
      } catch (error) {
        if (error instanceof AccountToolError) throw error
        const typed = networkSearchFailure(error, signal)
        if (typed instanceof AccountToolError) throw typed
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
  // Internal step of unlinked_lookup_contact, never a callable tool.
  const lookupContactOnce = tools.unlinked_lookup_contact_once
  delete tools.unlinked_lookup_contact_once

  Object.assign(tools, createPrivateNotesTools({ overlay, identityFor, getBackend, createError: (code, message, details) => new AccountToolError(code, message, details),
    lookupContact: (grant, input, signal) => tools.unlinked_lookup_contact(grant, input, signal) }))

  const askFailure = (error, signal) => {
    requestDiagnostic().failure(error, signal)
    if (error instanceof AccountToolError) return error
    if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') return new AccountToolError('upstream_unavailable', 'AI ranking did not finish within the time budget; retry, raise timeoutMs, or use the deterministic listing tools.')
    if (/query_invalid|query_limit/.test(String(error?.message))) return new AccountToolError('invalid_input', 'The query was empty or too long.')
    if (/not_found/.test(String(error?.message))) return new AccountToolError('not_found', 'An import referenced by the search is no longer published.')
    return new AccountToolError('upstream_unavailable', 'AI ranking is unavailable right now; retry.')
  }

  // revalidate (when supplied) must re-authenticate the live grant and throw
  // on revoked/replaced identity or removal of the requested permission. Unrelated
  // permission edits are allowed. Reads recheck after work; writes recheck before
  // execution (send also after target lookup), never misreport a committed write.
  async function call({ grant, name, input = {}, signal, revalidate, requestContext, admission }) {
    if (!grant || typeof grant.ownerId !== 'string' || typeof grant.userId !== 'string' || !Array.isArray(grant.tools)) throw new AccountToolError('grant_revoked', 'The grant is no longer valid.')
    if (!Object.hasOwn(tools, name)) throw new AccountToolError('not_found', 'Unknown tool.')
    if (!grant.tools.includes(name)) throw new AccountToolError('scope_not_granted', `This grant does not include ${name}.`)
    if (WRITE_TOOLS.has(name) && !scopeAllowsConnectionActions(grant.scope)) throw new AccountToolError('scope_not_granted', 'Connection actions require an explicit opt-in grant.')
    if (PRIVATE_NOTES_TOOL_SET.has(name) && !scopeAllowsPrivateNotes(grant.scope)) throw new AccountToolError('scope_not_granted', 'Private people notes & relations are switched off for this key (Settings) or not consented for this app.')
    searchActivity().tool(name, input)
    const parsed = z.object(ACCOUNT_TOOL_SCHEMAS[name]).strict().safeParse(input)
    if (!parsed.success) throw new AccountToolError('invalid_input', parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 512))
    const release = admission === INTERNAL_BULK_READ && DETERMINISTIC_TOOLS.has(name) || await isVerified(grant) ? null : DETERMINISTIC_TOOLS.has(name) ? admitDeterministic(grant.ownerId) ?? null : WRITE_TOOLS.has(name) ? admitWrite(grant.ownerId) ?? null : admitAi(grant.ownerId)
    try {
      const execute = async () => {
      if (coordination && MUTATING_TOOLS.has(name) && requestContext?.ownerCheckpoint !== undefined && coordination.version(grant.ownerId) > requestContext.ownerCheckpoint) throw new AccountToolError('grant_revoked', 'The account changed during this request; reconnect and retry.')
      if (typeof revalidate === 'function') grant = await revalidate() ?? grant
      const result = await tools[name](grant, parsed.data, signal, revalidate)
      // A write has already happened by now; only reads are withheld when the
      // grant was revoked mid-call, so a landed write is never reported as failed.
      if (typeof revalidate === 'function' && !MUTATING_TOOLS.has(name)) {
        const current = await revalidate()
        if (name === 'unlinked_whoami' && current) result.grant = { ...result.grant, scope: current.scope, version: current.version, tools: [...current.tools] }
      }
      searchActivity().result(result, name)
      const text = JSON.stringify(result)
      if (Buffer.byteLength(text) > 1024 * 1024) throw new AccountToolError('result_too_large', 'The result exceeded 1 MiB; narrow the query or lower the page size.')
      return { result, text }
      }
      return coordination && MUTATING_TOOLS.has(name) ? await coordination.run(['owner:' + grant.ownerId], execute) : await execute()
    } finally { release?.(); if (MUTATING_TOOLS.has(name)) dropOwnerNetwork(grant.ownerId) }
  }

  // Hosted launch tools preserve their historical result/page shape while
  // sharing the same per-owner and process-wide AI admission as REST/tools.
  async function withSearchBudget(grant, name, work) {
    if (!['unlinked_search_network', 'unlinked_search_everyone'].includes(name) || !grant?.tools?.includes(name)) throw new AccountToolError('scope_not_granted', 'This grant does not include the requested search.')
    const release = await isVerified(grant) ? () => {} : admitAi(grant.ownerId)
    try { return await work() } finally { release() }
  }
  return { call, withSearchBudget }
}
