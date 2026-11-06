import { createHash, randomUUID } from 'node:crypto'
import { parseLinkedinProfileUrl } from '../src/utils/linkedin-profile-url.mjs'
import { normalizeLookupProfile } from './signup-profile-lookup.mjs'
import { lockProfileOwner } from './profile-source-boundary.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keyFor = owner => {
  if (!owner?.ownerId || !owner.userId) throw Error('person_lookup_owner_required')
  return hash([owner.ownerId, owner.userId])
}
const DAY = 86400000
export const personLookupNotice = code => ({
  invalid_url: 'Paste a LinkedIn profile URL, like linkedin.com/in/their-name.',
  disabled: 'Live LinkedIn lookup is unavailable. You can still add this person by name.',
  not_found: 'LinkedIn returned no profile for this address. Check the link or add the person by name.',
  timeout: 'LinkedIn lookup timed out. Try again later; nothing was added.',
  refused: 'LinkedIn could not share this profile. You can still add the person by name.',
  paced: 'LinkedIn lookups are busy. Try again shortly.',
  daily_cap: 'LinkedIn lookup has reached today’s limit. Try again later or add the person by name.',
  owner_limit: 'You have reached today’s LinkedIn lookup limit. Try again later or add the person by name.',
  unavailable: 'LinkedIn lookup is temporarily unavailable. Nothing was added.',
}[code] ?? 'LinkedIn lookup is temporarily unavailable. Nothing was added.')

// General people discovery is separate from signup claims and their three-try
// lifetime allowance. This service never claims or publishes an identity.
export function createPersonLookup({ store, settings, adapter, now = Date.now }) {
  return {
    async lookup({ owner, address }) {
      const parsed = parseLinkedinProfileUrl(address)
      if (!parsed) return { status: 'unavailable', code: 'invalid_url' }
      const key = keyFor(owner)
      if (!settings || typeof adapter?.lookup !== 'function') return { status: 'unavailable', code: 'disabled' }
      const attempt = randomUUID(), time = now()
      const args = { key, owner, slug: parsed.slug, attempt, now: time, day: Math.floor(time / DAY), dailyCap: settings.dailyCap, pacingMs: settings.pacingMs, timeoutMs: settings.timeoutMs }
      try {
        const reservation = await store.reserve(args)
        if (reservation.profile) return { status: 'found', profile: normalizeLookupProfile(reservation.profile), address: parsed.url, observedAt: reservation.observedAt, cached: true }
        if (!reservation.allowed) return { status: 'unavailable', code: reservation.code }
        const controller = new AbortController()
        let deadline, result
        try {
          const expired = new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(Object.assign(Error('timeout'), { code: 'timeout' })) }, settings.timeoutMs) })
          const data = await Promise.race([Promise.resolve().then(() => adapter.lookup(parsed.slug, { signal: controller.signal })), expired])
          result = data == null ? { code: 'not_found' } : { profile: normalizeLookupProfile(data) }
        } catch (error) { result = { code: controller.signal.aborted || error?.code === 'timeout' ? 'timeout' : error?.code === 'refused' ? 'refused' : 'unavailable' } }
        finally { clearTimeout(deadline) }
        const saved = await store.finish({ ...args, ...result, now: now() })
        if (!saved) return { status: 'unavailable', code: 'unavailable' }
        return result.profile ? { status: 'found', profile: result.profile, address: parsed.url, observedAt: now(), cached: false } : { status: 'unavailable', code: result.code }
      } catch { return { status: 'unavailable', code: 'unavailable' } }
    },
    // Name searches share the exact same durable global/owner quota and lease
    // as URL lookups. Results are proposals, retained only on the viewer contact.
    async search({ owner, query }) {
      if (typeof query !== 'string' || !query.trim() || query.length > 200) return { status: 'unavailable', code: 'invalid_query' }
      if (!settings || typeof adapter?.search !== 'function') return { status: 'unavailable', code: 'disabled' }
      const time = now(), args = { key: keyFor(owner), owner, slug: 'contact-search-' + hash(query), attempt: randomUUID(), now: time, day: Math.floor(time / DAY), dailyCap: settings.dailyCap, pacingMs: settings.pacingMs, timeoutMs: settings.timeoutMs }
      try {
        const reserved = await store.reserve(args)
        if (!reserved.allowed) return { status: 'unavailable', code: reserved.code ?? 'unavailable' }
        const controller = new AbortController()
        let deadline, candidates, code
        try {
          const expired = new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(Error('timeout')) }, settings.timeoutMs) })
          candidates = await Promise.race([Promise.resolve().then(() => adapter.search(query, { signal: controller.signal })), expired])
          if (!Array.isArray(candidates)) throw Error('unavailable')
        } catch { code = controller.signal.aborted ? 'timeout' : 'unavailable' }
        finally { clearTimeout(deadline) }
        if (!await store.finish({ ...args, code: code ?? 'search_complete', now: now() })) return { status: 'unavailable', code: 'unavailable' }
        return code ? { status: 'unavailable', code } : { status: 'found', candidates: candidates.slice(0, 50) }
      } catch { return { status: 'unavailable', code: 'unavailable' } }
    },
    removeOwner: owner => store.removeOwner(owner),
  }
}

// Share the signup singleton/budget and its whitelisted public-profile cache:
// two routes cannot multiply the configured system-account provider allowance.
// Separate owner counters are durable and survive both sessions and restarts.
export function createNeo4jPersonLookupStore(driver, database = 'neo4j', gateId = 'profile-lookup') {
  const tx = async work => { const session = driver.session({ database }); try { return await session.executeWrite(t => work({ run: (query, params = {}) => t.run(query, { ...params, gateId }) })) } finally { await session.close() } }
  const num = value => Number(value?.toNumber?.() ?? value ?? 0)
  return {
    initialize: () => tx(t => t.run('CREATE CONSTRAINT unlinkedpersonlookup_key IF NOT EXISTS FOR (n:UnlinkedPersonLookup) REQUIRE n.key IS UNIQUE')),
    reserve: args => tx(async t => {
      await t.run("MERGE (g:UnlinkedSignupGate {id:$gateId}) ON CREATE SET g.day=-1,g.used=0,g.nextAt=0 SET g._lock=true REMOVE g._lock")
      await lockProfileOwner(t, args.owner)
      const result = await t.run(`MATCH (g:UnlinkedSignupGate {id:$gateId})
        MERGE (a:UnlinkedPersonLookup {key:$key}) ON CREATE SET a.ownerId=$ownerId,a.userId=$userId
        WITH g,a OPTIONAL MATCH (c:UnlinkedSignupCache {slug:$slug})
        RETURN properties(g) AS g,properties(a) AS a,c.json AS cached,c.observedAt AS observedAt`, { key: args.key, ...args.owner, slug: args.slug })
      const row = result.records[0], a = row.get('a'), g = row.get('g')
      if (row.get('cached') && num(row.get('observedAt')) > args.now - DAY) return { profile: JSON.parse(row.get('cached')), observedAt: num(row.get('observedAt')) }
      const used = num(g.day) === args.day ? num(g.used) : 0, attempts = num(a.day) === args.day ? num(a.attempts) : 0
      if (attempts >= 20) return { code: 'owner_limit' }
      if (used >= args.dailyCap) return { code: 'daily_cap' }
      if (num(g.nextAt) > args.now || num(g.pendingUntil) > args.now || num(a.pendingUntil) > args.now) return { code: 'paced' }
      await t.run(`MATCH (g:UnlinkedSignupGate {id:$gateId}),(a:UnlinkedPersonLookup {key:$key})
        SET g.day=$day,g.used=$used,g.nextAt=$nextAt,g.attempt=$attempt,g.pendingUntil=$pendingUntil,
        a.day=$day,a.attempts=$attempts,a.pendingUntil=$pendingUntil,a.attempt=$attempt`,
      { key: args.key, day: args.day, used: used + 1, attempts: attempts + 1, nextAt: args.now + args.pacingMs, attempt: args.attempt, pendingUntil: args.now + args.timeoutMs + 15000 })
      return { allowed: true }
    }),
    finish: args => tx(async t => {
      await t.run("MATCH (g:UnlinkedSignupGate {id:$gateId}) SET g._lock=true REMOVE g._lock")
      await lockProfileOwner(t, args.owner)
      const result = await t.run('MATCH (a:UnlinkedPersonLookup {key:$key,attempt:$attempt}) SET a.pendingUntil=0 RETURN a.key AS key', { key: args.key, attempt: args.attempt })
      if (!result.records.length) return false
      const gate = await t.run("MATCH (g:UnlinkedSignupGate {id:$gateId,attempt:$attempt}) SET g.pendingUntil=0,g.nextAt=$nextAt RETURN g.id AS id", { attempt: args.attempt, nextAt: args.now + args.pacingMs })
      if (!gate.records.length) return false // an expired/replaced lease cannot write
      if (args.profile) await t.run('MERGE (c:UnlinkedSignupCache {slug:$slug}) SET c.json=$json,c.observedAt=$observedAt', { slug: args.slug, json: JSON.stringify(args.profile), observedAt: args.now })
      return true
    }),
    removeOwner: owner => tx(async t => {
      await lockProfileOwner(t, owner, { requireActive: false })
      await t.run('MATCH (a:UnlinkedPersonLookup {key:$key,ownerId:$ownerId,userId:$userId}) DETACH DELETE a', { key: keyFor(owner), ...owner })
    }),
  }
}
