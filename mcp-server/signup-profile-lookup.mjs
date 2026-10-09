import { lockProfileOwner } from './profile-source-boundary.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { linkedinUrl } from '../src/utils/private-import/archive.mjs'
import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'

// Optional operator-configured public profile lookup at signup
// (docs/signup-profile-lookup.md). The lookup itself is a private host module
// implementing the adapter contract below; every guardrail lives here.
//
//   lookup(slug, { signal }) -> Promise<{ name, headline?, location?, about?,
//     positions?: [{ title, company, startDate?, endDate?, description? }],
//     education?: [{ institution, degree?, startDate?, endDate? }],
//     skills?: [string] } | null>
//
// null means no public profile. Failures throw an Error whose `code` is one
// of PROFILE_LOOKUP_ERRORS; anything else is treated as `unavailable`.
export const PROFILE_LOOKUP_ROOT = '/srv/unlinked-private-guest-pilot-20261001/runtime/private/'
export const PROFILE_LOOKUP_ERRORS = Object.freeze(['unavailable', 'timeout', 'refused'])
export class ProfileLookupError extends Error {
  constructor(code) { super(code); this.name = 'ProfileLookupError'; this.code = PROFILE_LOOKUP_ERRORS.includes(code) ? code : 'unavailable' }
}

const hash = value => createHash('sha256').update(value).digest('hex')
const ownerKey = owner => {
  if (!owner?.ownerId || !owner.userId) throw Error('signup_profile_owner_required')
  return hash(JSON.stringify([owner.ownerId, owner.userId]))
}
export const signupProfileId = owner => 'member-signup-' + ownerKey(owner)
export function signupProfileSlug(address) {
  if (typeof address !== 'string' || address.length > 2048) return null
  let parsed
  try {
    parsed = new URL(/^https:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`)
    // Share my profile adds tracking query parameters and sometimes a fragment.
    // Strip them only after validating the exact LinkedIn profile origin.
    if (parsed.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) return null
    parsed.search = ''; parsed.hash = ''
  } catch { return null }
  const url = linkedinUrl(parsed.href)
  const slug = url && linkedinSlug(url)
  return slug && /^[\p{L}\p{N}_.-]{1,120}$/u.test(slug) ? slug : null
}

// Off unless UNLINKED_PROFILE_LOOKUP_ADAPTER names a module under the fixed
// private root; invalid limits also leave it off.
export function profileLookupSettings(env = process.env, { root = PROFILE_LOOKUP_ROOT } = {}) {
  const adapterPath = env.UNLINKED_PROFILE_LOOKUP_ADAPTER
  if (typeof adapterPath !== 'string' || !adapterPath.trim()) return null
  if (!isAbsolute(adapterPath) || normalize(adapterPath) !== adapterPath || !adapterPath.startsWith(root) || adapterPath.length <= root.length) return null
  try {
    const number = (name, fallback, min, max) => { const value = env[name] === undefined ? fallback : Number(env[name]); if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('config'); return value }
    return { adapterPath, dailyCap: number('UNLINKED_PROFILE_LOOKUP_DAILY_CAP', 150, 0, 1000), pacingMs: number('UNLINKED_PROFILE_LOOKUP_PACING_MS', 4000, 4000, 60000),
      timeoutMs: number('UNLINKED_PROFILE_LOOKUP_TIMEOUT_MS', 12000, 1000, 30000) }
  } catch { return null }
}

// Loaded once at startup. The module must be a regular file (not a symlink, no
// symlinked parent) owned by the runtime user, mode 600 or stricter, under the
// fixed private root. Errors carry only a fixed code, never module output.
export async function loadProfileLookupAdapter(settings, { root = PROFILE_LOOKUP_ROOT, uid = process.getuid?.(), importModule = path => import(pathToFileURL(path).href) } = {}) {
  if (!settings) return null
  const path = settings.adapterPath
  if (typeof path !== 'string' || !path.startsWith(root) || normalize(path) !== path) throw Error('profile_lookup_adapter_path')
  let info, real
  try { info = await lstat(path); real = await realpath(path) } catch { throw Error('profile_lookup_adapter_missing') }
  if (!info.isFile() || info.isSymbolicLink() || real !== path) throw Error('profile_lookup_adapter_path')
  if (uid === undefined || info.uid !== uid || (info.mode & 0o177) !== 0 || !(info.mode & 0o400)) throw Error('profile_lookup_adapter_permissions')
  let loaded
  try { loaded = await importModule(path) } catch { throw Error('profile_lookup_adapter_import') }
  const adapter = typeof loaded?.default?.lookup === 'function' ? loaded.default : loaded
  if (typeof adapter?.lookup !== 'function') throw Error('profile_lookup_adapter_contract')
  return { lookup: (slug, options) => adapter.lookup(slug, options) }
}

// Startup wiring: settings plus the loaded adapter, or the feature stays off
// with one fixed-code log line. The adapter's own errors are never logged.
export async function prepareProfileLookup({ env = process.env, load = loadProfileLookupAdapter, log = () => {} } = {}) {
  const settings = profileLookupSettings(env)
  if (!settings) {
    if (typeof env.UNLINKED_PROFILE_LOOKUP_ADAPTER === 'string' && env.UNLINKED_PROFILE_LOOKUP_ADAPTER.trim()) log('profile_lookup_disabled: invalid UNLINKED_PROFILE_LOOKUP_* configuration')
    return { settings: null, adapter: null }
  }
  try { return { settings, adapter: await load(settings) } } catch (error) {
    log(`profile_lookup_disabled: ${/^profile_lookup_adapter_[a-z]+$/.test(error?.message) ? error.message : 'profile_lookup_adapter_unavailable'}`)
    return { settings: null, adapter: null }
  }
}

const text = (value, limit = 20000) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const rows = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : []
// Adapter output is untrusted: only these bounded professional fields survive.
// Never retain raw payloads, identifiers, contact details or photos.
export function normalizeLookupProfile(data) {
  if (!data || typeof data !== 'object') throw Error('invalid_profile')
  const name = text(data.name, 400)
  if (!name) throw Error('invalid_profile')
  const profile = { name, positions: [], education: [], skills: [] }
  for (const key of ['headline', 'location', 'about']) if (text(data[key])) profile[key] = text(data[key])
  for (const row of rows(data.positions, 100)) {
    if (!text(row?.title) || !text(row?.company)) continue
    const item = { title: text(row.title), company: text(row.company) }
    for (const [key, limit] of [['startDate', 80], ['endDate', 80], ['description', 20000]]) if (text(row[key], limit)) item[key] = text(row[key], limit)
    profile.positions.push(item)
  }
  if (profile.positions.length) profile.company = profile.positions[0].company
  for (const row of rows(data.education, 100)) {
    if (!text(row?.institution)) continue
    const item = { institution: text(row.institution) }
    for (const [key, limit] of [['degree', 20000], ['startDate', 80], ['endDate', 80]]) if (text(row[key], limit)) item[key] = text(row[key], limit)
    profile.education.push(item)
  }
  profile.skills = rows(data.skills, 500).map(value => text(value, 200)).filter(Boolean)
  return profile
}
const failureCode = (error, signal) => signal.aborted || error?.code === 'timeout' || error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
  : error?.code === 'refused' ? 'lookup_refused' : 'lookup_unavailable'

export const signupLookupNotice = code => ({
  slug_claimed: 'That profile is already claimed. You can continue with your name and add your LinkedIn export later.',
  disabled: 'LinkedIn profile lookup is not available right now. We checked saved Unlinked profiles but could not fetch LinkedIn. You can add your LinkedIn export instead.',
  invalid_url: 'Paste a LinkedIn profile address like https://www.linkedin.com/in/your-name/. Links copied with Share my profile work, including tracking parameters.',
  not_found: 'No profile was returned for that LinkedIn address. Check the link, try again, or add your LinkedIn export.',
  timeout: 'LinkedIn profile lookup timed out. Your link is still below so you can try again or add your export.',
  lookup_unavailable: 'LinkedIn profile lookup is temporarily unavailable. Your link is still below so you can try again or add your export.',
  lookup_refused: 'The lookup provider could not retrieve that LinkedIn profile. You can add your LinkedIn export instead.',
  storage_unavailable: 'We couldn’t complete the profile lookup. Please try again or add your LinkedIn export.',
  paced: 'Profile lookups are busy. Try again shortly, or continue with your name and add your export later.',
  daily_cap: 'Profile lookups have reached today’s limit. You can continue with your name and add your export later.',
  account_limit: 'You can continue with your name and add your LinkedIn export to build your profile.',
}[code] ?? 'We couldn’t find your public profile right now. You can continue with your name and add your export later.')

export function createSignupProfileLookup({ store, settings = null, adapter = null, now = Date.now }) {
  const enabled = Boolean(settings && typeof adapter?.lookup === 'function')
  return {
    async lookup({ owner, address }) {
      const slug = signupProfileSlug(address)
      if (!slug) return { status: 'unavailable', code: 'invalid_url' }
      if (!enabled) return { status: 'unavailable', code: 'disabled' }
      const key = ownerKey(owner), attempt = randomUUID(), time = now()
      try {
        const reserved = await store.reserve({ key, slug, attempt, now: time, day: Math.floor(time / 86400000), dailyCap: settings.dailyCap, pacingMs: settings.pacingMs, timeoutMs: settings.timeoutMs })
        if (reserved.profile) return { status: 'found', slug, profile: reserved.profile }
        if (!reserved.allowed) return { status: 'unavailable', code: reserved.code }
        let result
        const signal = AbortSignal.timeout(settings.timeoutMs)
        try {
          // The deadline holds even if an adapter ignores its signal.
          const expired = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
          const data = await Promise.race([Promise.resolve().then(() => adapter.lookup(slug, { signal })), expired])
          result = data == null ? { code: 'not_found' } : { profile: normalizeLookupProfile(data) }
        } catch (error) { result = { code: failureCode(error, signal) } }
        const saved = await store.finish({ key, slug, attempt, now: now(), pacingMs: settings.pacingMs, ...result })
        if (saved?.code) return { status: 'unavailable', code: saved.code }
        return saved && result.profile ? { status: 'found', slug, profile: result.profile } : { status: 'unavailable', code: result.code ?? 'storage_unavailable' }
      } catch { return { status: 'unavailable', code: 'storage_unavailable' } }
    },
    async confirm({ owner, slug }) {
      const key = ownerKey(owner), profileId = signupProfileId(owner)
      const receiptId = hash(JSON.stringify(['self-asserted-public-profile-v1', key, slug]))
      if (!await store.confirm({ key, owner, slug, profileId, receiptId, now: now() })) throw Error('self_claim_conflict')
      return { profileId, receiptId }
    },
    read: owner => store.read(owner),
    readForExport: owner => store.read(owner, { includeRetired: true }),
    list: () => store.list(),
    removeOwner: owner => store.removeOwner(owner),
  }
}

// Reservation policy shared by durable transactions and executable fixtures.
export function signupReservation({ account, gate, cached }, args) {
  const num = value => Number(value?.toNumber?.() ?? value ?? 0)
  if (account.json) return account.slug === args.slug ? { profile: JSON.parse(account.json) } : { code: 'account_limit' }
  if (account.succeeded) return { code: 'account_limit' }
  if (num(account.pendingUntil) > args.now) return { code: 'paced' }
  if (cached) return { profile: JSON.parse(cached) }
  if (num(account.attempts) >= 3) return { code: 'account_limit' }
  const used = num(gate.day) === args.day ? num(gate.used) : 0
  if (used >= args.dailyCap) return { code: 'daily_cap' }
  if (num(gate.nextAt) > args.now || num(gate.pendingUntil) > args.now) return { code: 'paced' }
  return { allowed: true, used: used + 1 }
}

// Shared transactional singleton serializes every reservation across processes.
// Calls are rejected while paced; no unbounded queue, sleeps or hidden retries.
export function createNeo4jSignupProfileStore(driver, database = 'neo4j', gateId = 'profile-lookup') {
  const tx = async (mode, fn) => { const session = driver.session({ database }); try { return await session[mode](t => fn({ run: (query, params = {}) => t.run(query, { ...params, gateId }) })) } finally { await session.close() } }
  const write = (query, params = {}) => tx('executeWrite', t => t.run(query, params))
  const parsed = records => records.map(record => JSON.parse(record.get('json')))
  const active = `MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:s.ownerId, userId:s.userId}) WHERE coalesce(b.active,true) = true`
  // Inactive owner bindings do not hold a public identity. Remove their unique
  // claim before checking the slug; retired records remain available for audit.
  const releaseInactive = (t, slug = null) => t.run(`MATCH (s:UnlinkedSignupProfile) WHERE $slug IS NULL OR s.slug=$slug
    OPTIONAL MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:s.ownerId, userId:s.userId}) WHERE coalesce(b.active,true)=true
    WITH s, count(b) AS bindings WHERE coalesce(s.retired,false)=true OR bindings=0
    SET s.retired=true, s.retiredAt=coalesce(s.retiredAt,$now), s.retiredReason=coalesce(s.retiredReason,'owner-inactive-v1')
    REMOVE s.activeSlug`, { slug, now: Date.now() })
  const slugClaimed = async (t, { key, slug }) => {
    await releaseInactive(t, slug)
    const result = await t.run(`MATCH (s:UnlinkedSignupProfile {slug:$slug}) ${active}
      AND coalesce(s.retired,false)=false AND s.key<>$key RETURN s.key AS key LIMIT 1`, { key, slug })
    return result.records.length > 0
  }
  return {
    async initialize() {
      for (const [label, property] of [['UnlinkedSignupLookup','key'], ['UnlinkedSignupCache','slug'], ['UnlinkedSignupGate','id'], ['UnlinkedSignupProfile','key'], ['UnlinkedSignupProfile','activeSlug']]) await write(`CREATE CONSTRAINT ${label.toLowerCase()}_${property} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`)
      // Backfill pre-constraint sources atomically; ambiguous existing active
      // claims fail closed rather than choosing or publishing two identities.
      await tx('executeWrite', async t => {
        await t.run("MERGE (g:UnlinkedSignupGate {id:$gateId}) SET g._lock=true REMOVE g._lock")
        await releaseInactive(t)
        await t.run(`MATCH (s:UnlinkedSignupProfile) ${active} AND coalesce(s.retired,false)=false SET s.activeSlug=s.slug`)
      })
    },
    reserve: args => tx('executeWrite', async t => {
      await t.run(`MERGE (g:UnlinkedSignupGate {id:$gateId}) ON CREATE SET g.day=-1, g.used=0, g.nextAt=0 SET g._lock=true REMOVE g._lock`)
      if (await slugClaimed(t, args)) return { code: 'slug_claimed' }
      const result = await t.run(`MATCH (g:UnlinkedSignupGate {id:$gateId})
        MERGE (a:UnlinkedSignupLookup {key:$key}) ON CREATE SET a.attempts=0
        WITH g, a
        OPTIONAL MATCH (c:UnlinkedSignupCache {slug:$slug})
        RETURN properties(g) AS g, properties(a) AS a, c.json AS cached`, args)
      const row = result.records[0]
      const decision = signupReservation({ account: row.get('a'), gate: row.get('g'), cached: row.get('cached') }, args)
      if (decision.profile) {
        await t.run('MATCH (a:UnlinkedSignupLookup {key:$key}) SET a.slug=$slug, a.json=$json, a.succeeded=true', { key: args.key, slug: args.slug, json: JSON.stringify(decision.profile) })
        return decision
      }
      if (!decision.allowed) return decision
      await t.run(`MATCH (g:UnlinkedSignupGate {id:$gateId}), (a:UnlinkedSignupLookup {key:$key})
        SET g.day=$day, g.used=$used, g.nextAt=$nextAt, g.attempt=$attempt, g.pendingUntil=$pendingUntil,
          a.attempts=coalesce(a.attempts,0)+1, a.slug=$slug, a.attempt=$attempt, a.pendingUntil=$pendingUntil`,
      { key: args.key, day: args.day, used: decision.used, nextAt: args.now + args.pacingMs, slug: args.slug, attempt: args.attempt, pendingUntil: args.now + args.timeoutMs + 15000 })
      return { allowed: true }
    }),
    async finish({ key, slug, attempt, profile, code, now, pacingMs }) {
      return tx('executeWrite', async t => {
        await t.run("MATCH (g:UnlinkedSignupGate {id:$gateId}) SET g._lock=true REMOVE g._lock")
        const result = await t.run(`MATCH (a:UnlinkedSignupLookup {key:$key, attempt:$attempt, slug:$slug})
          SET a.pendingUntil=0, a.failure=$code ${profile ? ', a.json=$json, a.succeeded=true' : ''} RETURN a.key AS key`, { key, slug, attempt, code: code ?? null, json: profile ? JSON.stringify(profile) : null })
        if (!result.records.length) return false
        await t.run("MATCH (g:UnlinkedSignupGate {id:$gateId, attempt:$attempt}) SET g.pendingUntil=0, g.nextAt=$nextAt", { attempt, nextAt: now + pacingMs })
        if (profile) await t.run('MERGE (c:UnlinkedSignupCache {slug:$slug}) SET c.json=$json', { slug, json: JSON.stringify(profile) })
        if (profile && await slugClaimed(t, { key, slug })) return { code: 'slug_claimed' }
        return true
      })
    },
    async confirm({ key, owner, slug, profileId, receiptId, now }) {
      try {
        const result = await tx('executeWrite', async t => {
          await t.run("MERGE (g:UnlinkedSignupGate {id:$gateId}) SET g._lock=true REMOVE g._lock")
          await lockProfileOwner(t, owner)
          if (await slugClaimed(t, { key, slug })) return { records: [] }
          return t.run(`MATCH (a:UnlinkedSignupLookup {key:$key, slug:$slug}) WHERE a.json IS NOT NULL
          MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId}) WHERE coalesce(b.active,true)=true
          OPTIONAL MATCH (l:UnlinkedLegacyAccount {ownerId:$ownerId})
          WITH a, b, l WHERE l IS NULL
          MERGE (s:UnlinkedSignupProfile {key:$key}) ON CREATE SET s.ownerId=$ownerId, s.userId=$userId, s.profileId=$profileId, s.slug=$slug,
            s.profileJson=a.json, s.receiptId=$receiptId, s.confirmedAt=$now, s.source='self-asserted-public-profile-v1'
          WITH s WHERE coalesce(s.retired,false)=false AND s.slug=$slug SET s.activeSlug=$slug RETURN s.profileId AS id`, { key, ...owner, slug, profileId, receiptId, now })
        })
        return result.records.length === 1
      } catch (error) {
        if (error?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') return false
        throw error
      }
    },
    async removeOwner(owner) {
      await tx('executeWrite', async t => {
        await t.run("MERGE (g:UnlinkedSignupGate {id:$gateId}) SET g._lock=true REMOVE g._lock")
        await lockProfileOwner(t, owner, { requireActive: false })
        await t.run(`MATCH (s:UnlinkedSignupProfile {key:$key, ownerId:$ownerId, userId:$userId}) DETACH DELETE s`, { key: ownerKey(owner), ...owner })
        await t.run(`MATCH (a:UnlinkedSignupLookup {key:$key})
          WITH a, {key:a.key, attempts:coalesce(a.attempts,0), succeeded:coalesce(a.succeeded,false) OR a.json IS NOT NULL} AS quota
          SET a = quota`, { key: ownerKey(owner) })
      })
    },
    async read(owner, { includeRetired = false } = {}) {
      return tx('executeRead', async t => {
        const result = await t.run(`MATCH (s:UnlinkedSignupProfile {key:$key}) ${active} AND ($includeRetired OR coalesce(s.retired,false)=false) RETURN s.profileJson AS json, s.profileId AS id, s.receiptId AS receiptId, s.retired AS retired, s.retiredByProfileId AS retiredByProfileId`, { key: ownerKey(owner), includeRetired })
        if (!result.records.length) return null
        const row = result.records[0]; return { profile: { ...JSON.parse(row.get('json')), id: row.get('id') }, receiptId: row.get('receiptId'), ...(row.get('retired') === true ? { retired: true, retiredByProfileId: row.get('retiredByProfileId') } : {}) }
      })
    },
    async list() {
      return tx('executeRead', async t => {
        const result = await t.run(`MATCH (s:UnlinkedSignupProfile) ${active} AND coalesce(s.retired,false)=false RETURN s.profileJson AS json, s.profileId AS id, s.ownerId AS ownerId, s.userId AS userId, s.receiptId AS receiptId ORDER BY id LIMIT 1001`)
        if (result.records.length > 1000) throw Error('public_signup_profile_limit')
        return parsed(result.records).map((profile, i) => { const row = result.records[i]; return { owner: { ownerId: row.get('ownerId'), userId: row.get('userId') }, profile: { ...profile, id: row.get('id') }, receiptId: row.get('receiptId') } })
      })
    },
  }
}
