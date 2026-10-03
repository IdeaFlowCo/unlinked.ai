import { createHash, randomUUID } from 'node:crypto'
import { linkedinUrl } from '../src/utils/private-import/archive.mjs'
import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const ownerKey = owner => {
  if (!owner?.ownerId || !owner.userId) throw Error('signup_profile_owner_required')
  return hash(JSON.stringify([owner.ownerId, owner.userId]))
}
export const signupProfileId = owner => 'member-linkedin-' + ownerKey(owner)
export function signupLinkedinSlug(address) {
  const url = linkedinUrl(/^https:\/\//i.test(address) ? address : `https://${address}`)
  const slug = url && linkedinSlug(url)
  return slug && /^[\p{L}\p{N}_.-]{1,120}$/u.test(slug) ? slug : null
}
export function unipileConfig(env = process.env) {
  if (![env.UNLINKED_UNIPILE_BASE, env.UNLINKED_UNIPILE_KEY, env.UNLINKED_UNIPILE_ACCOUNT_ID].every(value => typeof value === 'string' && value.trim())) return null
  try {
    const base = new URL(env.UNLINKED_UNIPILE_BASE)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['/', '/api/v1', '/api/v1/'].includes(base.pathname)) return null
    base.pathname = '/api/v1/'
    const number = (name, fallback, min, max) => { const value = env[name] === undefined ? fallback : Number(env[name]); if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('config'); return value }
    return { base: base.href, key: env.UNLINKED_UNIPILE_KEY, accountId: env.UNLINKED_UNIPILE_ACCOUNT_ID,
      dailyCap: number('UNLINKED_UNIPILE_DAILY_CAP', 150, 0, 1000), pacingMs: number('UNLINKED_UNIPILE_PACING_MS', 4000, 4000, 60000),
      timeoutMs: number('UNLINKED_UNIPILE_TIMEOUT_MS', 12000, 1000, 30000) }
  } catch { return null }
}
const text = (value, limit = 20000) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const date = value => {
  const raw = text(value, 80), parts = raw.split('/')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return parts.length === 3 && months[Number(parts[0]) - 1] ? `${months[Number(parts[0]) - 1]} ${parts[2]}` : raw
}
export function mapSignupLinkedin(data) {
  if (!data || typeof data !== 'object') throw Error('invalid_profile')
  const name = [text(data.first_name, 200), text(data.last_name, 200)].filter(Boolean).join(' ')
  if (!name) throw Error('invalid_profile')
  const profile = { name, positions: [], education: [], skills: [] }
  for (const [key, value] of Object.entries({ headline: data.headline, location: data.location, about: data.summary })) if (text(value)) profile[key] = text(value)
  for (const row of (Array.isArray(data.work_experience) ? data.work_experience : []).slice(0, 100)) {
    if (!text(row?.position) || !text(row?.company)) continue
    const item = { title: text(row.position), company: text(row.company) }
    for (const [key, value] of Object.entries({ startDate: date(row.start), endDate: date(row.end), description: text(row.description) })) if (value) item[key] = value
    profile.positions.push(item)
  }
  if (profile.positions.length) profile.company = profile.positions[0].company
  for (const row of (Array.isArray(data.education) ? data.education : []).slice(0, 100)) {
    if (!text(row?.school)) continue
    const item = { institution: text(row.school) }
    for (const [key, value] of Object.entries({ degree: text(row.degree), startDate: date(row.start), endDate: date(row.end) })) if (value) item[key] = value
    profile.education.push(item)
  }
  profile.skills = (Array.isArray(data.skills) ? data.skills : []).slice(0, 500).map(row => text(row?.name)).filter(Boolean)
  // Never retain raw payloads, provider ids, contacts or remote/data: photos.
  return profile
}
export const signupLookupNotice = code => ({
  disabled: 'Your LinkedIn export will fill in your profile. You can continue with your name for now.',
  paced: 'Profile lookups are busy. Try again shortly, or continue with your name and add your export later.',
  daily_cap: 'Profile lookups have reached today’s limit. You can continue with your name and add your export later.',
  account_limit: 'You can continue with your name and add your LinkedIn export to build your profile.',
}[code] ?? 'We couldn’t read your public LinkedIn profile right now. You can continue with your name and add your export later.')

export function createSignupLinkedin({ store, config = unipileConfig(), fetchImpl = fetch, now = Date.now }) {
  return {
    async lookup({ owner, address }) {
      const slug = signupLinkedinSlug(address)
      if (!slug) return { status: 'unavailable', code: 'invalid_url' }
      if (!config) return { status: 'unavailable', code: 'disabled' }
      const key = ownerKey(owner), attempt = randomUUID(), time = now()
      try {
        const reserved = await store.reserve({ key, slug, attempt, now: time, day: Math.floor(time / 86400000), dailyCap: config.dailyCap, pacingMs: config.pacingMs, timeoutMs: config.timeoutMs })
        if (reserved.profile) return { status: 'found', slug, profile: reserved.profile }
        if (!reserved.allowed) return { status: 'unavailable', code: reserved.code }
        let result
        try {
          const url = new URL('users/' + encodeURIComponent(slug), config.base)
          url.searchParams.set('account_id', config.accountId); url.searchParams.set('linkedin_sections', '*')
          const response = await fetchImpl(url, { headers: { 'X-API-KEY': config.key, accept: 'application/json' }, signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error' })
          if (!response.ok) { await response.body?.cancel(); result = { code: response.status === 429 ? 'provider_limit' : 'provider_unavailable' } }
          else {
            // Bound the body while streaming, not after JSON parsing.
            const reader = response.body.getReader(), chunks = []; let size = 0
            for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw Error('invalid_profile') } chunks.push(Buffer.from(value)) }
            result = { profile: mapSignupLinkedin(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          }
        } catch (error) { result = { code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'provider_unavailable' } }
        const saved = await store.finish({ key, slug, attempt, now: now(), pacingMs: config.pacingMs, ...result })
        return saved && result.profile ? { status: 'found', slug, profile: result.profile } : { status: 'unavailable', code: result.code ?? 'storage_unavailable' }
      } catch { return { status: 'unavailable', code: 'storage_unavailable' } }
    },
    async confirm({ owner, slug }) {
      const key = ownerKey(owner), profileId = signupProfileId(owner)
      const receiptId = hash(JSON.stringify(['self-asserted-public-linkedin-v1', key, slug]))
      if (!await store.confirm({ key, owner, slug, profileId, receiptId, now: now() })) throw Error('self_claim_conflict')
      return { profileId, receiptId }
    },
    read: owner => store.read(owner),
    list: () => store.list(),
  }
}

// Reservation policy shared by durable transactions and executable fixtures.
export function signupReservation({ account, gate, cached }, args) {
  const num = value => Number(value?.toNumber?.() ?? value ?? 0)
  if (account.json) return account.slug === args.slug ? { profile: JSON.parse(account.json) } : { code: 'account_limit' }
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
export function createNeo4jSignupLinkedinStore(driver, database = 'neo4j', gateId = 'unipile') {
  const tx = async (mode, fn) => { const session = driver.session({ database }); try { return await session[mode](t => fn({ run: (query, params = {}) => t.run(query, { ...params, gateId }) })) } finally { await session.close() } }
  const write = (query, params = {}) => tx('executeWrite', t => t.run(query, params))
  const parsed = records => records.map(record => JSON.parse(record.get('json')))
  const active = `MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:s.ownerId, userId:s.userId}) WHERE coalesce(b.active,true) = true`
  return {
    async initialize() {
      for (const [label, property] of [['UnlinkedSignupLookup','key'], ['UnlinkedSignupCache','slug'], ['UnlinkedSignupGate','id'], ['UnlinkedSignupProfile','key']]) await write(`CREATE CONSTRAINT ${label.toLowerCase()}_${property} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`)
    },
    reserve: args => tx('executeWrite', async t => {
      await t.run(`MERGE (g:UnlinkedSignupGate {id:$gateId}) ON CREATE SET g.day=-1, g.used=0, g.nextAt=0 SET g._lock=true REMOVE g._lock`)
      const result = await t.run(`MATCH (g:UnlinkedSignupGate {id:$gateId})
        MERGE (a:UnlinkedSignupLookup {key:$key}) ON CREATE SET a.attempts=0
        WITH g, a
        OPTIONAL MATCH (c:UnlinkedSignupCache {slug:$slug})
        RETURN properties(g) AS g, properties(a) AS a, c.json AS cached`, args)
      const row = result.records[0]
      const decision = signupReservation({ account: row.get('a'), gate: row.get('g'), cached: row.get('cached') }, args)
      if (decision.profile) {
        await t.run('MATCH (a:UnlinkedSignupLookup {key:$key}) SET a.slug=$slug, a.json=$json', { key: args.key, slug: args.slug, json: JSON.stringify(decision.profile) })
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
          SET a.pendingUntil=0, a.failure=$code ${profile ? ', a.json=$json' : ''} RETURN a.key AS key`, { key, slug, attempt, code: code ?? null, json: profile ? JSON.stringify(profile) : null })
        if (!result.records.length) return false
        await t.run("MATCH (g:UnlinkedSignupGate {id:$gateId, attempt:$attempt}) SET g.pendingUntil=0, g.nextAt=$nextAt", { attempt, nextAt: now + pacingMs })
        if (profile) await t.run('MERGE (c:UnlinkedSignupCache {slug:$slug}) SET c.json=$json', { slug, json: JSON.stringify(profile) })
        return true
      })
    },
    async confirm({ key, owner, slug, profileId, receiptId, now }) {
      const result = await write(`MATCH (a:UnlinkedSignupLookup {key:$key, slug:$slug}) WHERE a.json IS NOT NULL
        MATCH (b:OperationalOwner {namespace:'unlinked', sourceOwnerId:$ownerId, userId:$userId}) WHERE coalesce(b.active,true)=true
        OPTIONAL MATCH (l:UnlinkedLegacyAccount {ownerId:$ownerId})
        WITH a, b, l WHERE l IS NULL
        MERGE (s:UnlinkedSignupProfile {key:$key}) ON CREATE SET s.ownerId=$ownerId, s.userId=$userId, s.profileId=$profileId, s.slug=$slug,
          s.profileJson=a.json, s.receiptId=$receiptId, s.confirmedAt=$now, s.source='self-asserted-public-linkedin-v1'
        RETURN s.profileId AS id`, { key, ...owner, slug, profileId, receiptId, now })
      return result.records.length === 1
    },
    async read(owner) {
      return tx('executeRead', async t => {
        const result = await t.run(`MATCH (s:UnlinkedSignupProfile {key:$key}) ${active} RETURN s.profileJson AS json, s.profileId AS id, s.receiptId AS receiptId`, { key: ownerKey(owner) })
        if (!result.records.length) return null
        const row = result.records[0]; return { profile: { ...JSON.parse(row.get('json')), id: row.get('id') }, receiptId: row.get('receiptId') }
      })
    },
    async list() {
      return tx('executeRead', async t => {
        const result = await t.run(`MATCH (s:UnlinkedSignupProfile) ${active} RETURN s.profileJson AS json, s.profileId AS id, s.ownerId AS ownerId, s.userId AS userId, s.receiptId AS receiptId ORDER BY id LIMIT 1001`)
        if (result.records.length > 1000) throw Error('public_signup_profile_limit')
        return parsed(result.records).map((profile, i) => { const row = result.records[i]; return { owner: { ownerId: row.get('ownerId'), userId: row.get('userId') }, profile: { ...profile, id: row.get('id') }, receiptId: row.get('receiptId') } })
      })
    },
  }
}
