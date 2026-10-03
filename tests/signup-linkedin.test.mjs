import { memorySignupStore } from './helpers/signup-linkedin-store.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSignupLinkedin, unipileConfig, signupLinkedinSlug, mapSignupLinkedin, signupProfileId } from '../mcp-server/signup-linkedin.mjs'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const owner = { ownerId: 'owner-a', userId: 'user-a' }
const env = { UNLINKED_UNIPILE_BASE: 'https://unipile.invalid/api/v1', UNLINKED_UNIPILE_KEY: 'test-only-key', UNLINKED_UNIPILE_ACCOUNT_ID: 'shared-test-account' }
const payload = { first_name: 'Ceyda', last_name: 'Kıran', headline: 'Engineer', location: 'Istanbul', summary: 'Public bio', profile_picture_url: 'data:image/png;secret', email: 'private@example.invalid',
  work_experience: [{ position: 'Engineer', company: 'Example', start: '4/1/2025' }, { position: 'missing company' }], education: [{ school: 'Example University', degree: 'BS' }], skills: [{ name: 'Sailing' }] }

function fixture({ fetchImpl = async () => Response.json(payload), config = unipileConfig(env) } = {}) {
  let time = 100000
  const store = memorySignupStore(), calls = []
  const service = createSignupLinkedin({ store, config, now: () => time, fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args) } })
  return { store, calls, service, advance: ms => { time += ms }, lookup: (slug = 'ceyda-kıran', who = owner) => service.lookup({ owner: who, address: 'https://www.linkedin.com/in/' + slug }) }
}

test('strict URL normalizer accepts Unicode and encoded slugs, rejects arbitrary hosts, paths and schemes', async () => {
  for (const address of ['https://linkedin.com/in/ceyda-kıran/', 'linkedin.com/in/ceyda-k%C4%B1ran', 'https://www.linkedin.com/in/CEYDA-KIRAN']) assert.ok(signupLinkedinSlug(address))
  assert.equal(signupLinkedinSlug('linkedin.com/in/ceyda-k%C4%B1ran'), 'ceyda-kıran')
  for (const address of ['ceyda-kiran', 'https://evil.test/linkedin.com/in/ceyda', 'https://linkedin.com.evil.test/in/x', 'http://linkedin.com/in/x', 'https://linkedin.com/in/x?track=1', 'https://linkedin.com/in/x/extra', 'https://linkedin.com/in/%2Fbad', 'https://linkedin.com/in/%ZZ', 'https://name@linkedin.com/in/x', 'https://linkedin.com:123/in/x']) assert.equal(signupLinkedinSlug(address), null, address)
  const f = fixture(); assert.equal((await f.service.lookup({ owner, address: 'evil.test/linkedin.com/in/x' })).code, 'invalid_url'); assert.equal(f.calls.length, 0)
  const claims = createSelfClaims({ driver: {}, publicPeople: { read: async () => null }, slugIndex: async () => new Map([['ceyda-k%c4%b1ran-9b192227', 'legacy-ceyda']]) })
  assert.equal(await claims.lookupSlug('ceyda-kıran-9b192227'), 'legacy-ceyda')
  assert.equal(await claims.lookupSlug('ceyda-k%C4%B1ran-9b192227'), 'legacy-ceyda')
})

test('configuration is default off and validates caps/pacing; base supports host or the existing /api/v1 base', async () => {
  assert.equal(unipileConfig({}), null)
  for (const key of Object.keys(env)) assert.equal(unipileConfig({ ...env, [key]: '' }), null)
  assert.equal(unipileConfig(env).dailyCap, 150); assert.equal(unipileConfig(env).pacingMs, 4000)
  assert.equal(unipileConfig({ ...env, UNLINKED_UNIPILE_BASE: 'https://unipile.invalid' }).base, 'https://unipile.invalid/api/v1/')
  for (const change of [{ UNLINKED_UNIPILE_PACING_MS: '3999' }, { UNLINKED_UNIPILE_DAILY_CAP: '-1' }, { UNLINKED_UNIPILE_TIMEOUT_MS: 'Infinity' }, { UNLINKED_UNIPILE_BASE: 'http://unipile.invalid' }]) assert.equal(unipileConfig({ ...env, ...change }), null)
  const f = fixture({ config: null }); assert.equal((await f.lookup()).code, 'disabled'); assert.equal(f.calls.length, 0)
})

test('one read maps only professional fields, cached repeats never fetch, and confirmation alone publishes a self-asserted source', async () => {
  const f = fixture(), result = await f.lookup()
  assert.equal(result.status, 'found'); assert.equal(result.profile.name, 'Ceyda Kıran')
  assert.ok(!JSON.stringify([...f.store.accounts]).includes('test-only-key'))
  assert.equal(result.profile.positions[0].startDate, 'Apr 2025'); assert.equal(result.profile.education[0].institution, 'Example University')
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('data:'))
  const [url, options] = f.calls[0]
  assert.equal(url.pathname, '/api/v1/users/ceyda-k%C4%B1ran'); assert.equal(url.searchParams.get('account_id'), 'shared-test-account'); assert.equal(url.searchParams.get('linkedin_sections'), '*')
  assert.equal(options.headers['X-API-KEY'], 'test-only-key'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
  assert.equal(await f.service.read(owner), null); assert.deepEqual(await f.service.list(), [])
  assert.equal((await f.lookup()).status, 'found'); assert.equal((await f.lookup('different')).code, 'account_limit'); assert.equal(f.calls.length, 1)
  const other = { ownerId: 'owner-b', userId: 'user-b' }
  assert.equal((await f.lookup('ceyda-kıran', other)).status, 'found'); assert.equal(f.calls.length, 1)
  await assert.rejects(f.service.confirm({ owner: other, slug: 'wrong' }), /self_claim_conflict/)
  const confirmed = await f.service.confirm({ owner, slug: result.slug })
  assert.equal(confirmed.profileId, signupProfileId(owner)); assert.equal((await f.service.list()).length, 1)
  assert.equal((await f.service.read(owner)).profile.name, 'Ceyda Kıran')
  f.store.setActive(false); assert.deepEqual(await f.service.list(), []); assert.equal(await f.service.read(owner), null)
})

test('daily global budget counts failed requests; pacing spans accounts and UTC reset retains account limits', async () => {
  const f = fixture({ config: unipileConfig({ ...env, UNLINKED_UNIPILE_DAILY_CAP: '2' }), fetchImpl: async () => new Response('', { status: 503 }) })
  const other = { ownerId: 'owner-b', userId: 'user-b' }
  assert.equal((await f.lookup()).code, 'provider_unavailable')
  f.advance(3999); assert.equal((await f.lookup('other', other)).code, 'paced'); assert.equal(f.calls.length, 1)
  f.advance(1); assert.equal((await f.lookup('other', other)).code, 'provider_unavailable')
  f.advance(4000); assert.equal((await f.lookup()).code, 'daily_cap'); assert.equal(f.calls.length, 2)
  f.advance(86400000); assert.equal((await f.lookup()).code, 'provider_unavailable')
  f.advance(4000); assert.equal((await f.lookup()).code, 'provider_unavailable')
  f.advance(86400000); assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 4)
})

test('concurrent requests and in-flight reads cannot bypass the account or global gate', async () => {
  let release
  const f = fixture({ fetchImpl: () => new Promise(resolve => { release = () => resolve(Response.json(payload)) }) })
  const pending = f.lookup()
  await new Promise(resolve => setImmediate(resolve))
  f.advance(5000)
  assert.equal((await f.lookup()).code, 'paced')
  assert.equal((await f.lookup('other', { ownerId: 'owner-b', userId: 'user-b' })).code, 'paced')
  assert.equal(f.calls.length, 1); release(); assert.equal((await pending).status, 'found')
})

test('typed failures hide provider contents and allow only two retries, with no successful response published automatically', async () => {
  for (const fetchImpl of [async () => { throw new DOMException('secret-key raw details', 'TimeoutError') }, async () => new Response('secret-key', { status: 429 }), async () => new Response('not JSON'), async () => Response.json({ email: 'secret-key' }), async () => new Response('x'.repeat(1024 * 1024 + 1))]) {
    const f = fixture({ fetchImpl })
    for (let i = 0; i < 3; i++) { const result = await f.lookup(); assert.equal(result.status, 'unavailable'); assert.ok(!JSON.stringify(result).includes('secret-key')); f.advance(4000) }
    assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 3)
    assert.deepEqual(await f.service.list(), [])
  }
  assert.throws(() => mapSignupLinkedin({}), /invalid_profile/)
})

test('confirmed source appears in public People immediately; newer member export supersedes it at the same id and aliases the import', async () => {
  const f = fixture(); await f.lookup(); await f.service.confirm({ owner, slug: 'ceyda-kıran' })
  const id = 'a'.repeat(64), archiveSha256 = 'b'.repeat(64), contactId = 'c'.repeat(64)
  const job = { id, ownerId: owner.ownerId, archiveSha256, consent: PUBLIC_UPLOAD_CONSENT, status: 'indexed', counts: { accepted: 2, indexed: 2 }, createdAt: 1 }
  const snapshot = projectPublicMemberImport({ job, assertions: [
    { id: 'd'.repeat(64), importId: id, ownerId: owner.ownerId, category: 'profile', fields: { 'first name': 'Ceyda', 'last name': 'Kıran', headline: 'Export wins' } },
    { id: contactId, importId: id, ownerId: owner.ownerId, category: 'connections', fields: { 'first name': 'My', 'last name': 'Contact' } },
  ] })
  let imports = []
  const read = createMemberPublicIndex({ readLegacy: async () => ({ state: 'published', complete: true, revision: 'legacy-public-v1:' + 'e'.repeat(64), profiles: [], connections: [] }),
    discover: async () => imports, readSignupProfiles: f.service.list, readMembers: async () => [],
    getBackend: async () => ({ readResource: async () => ({ payload: job, sourceOwnerId: owner.ownerId, sourceRevision: 1 }) }),
    publicPeople: { read: async dataset => dataset === ENRICHMENT_DATASET ? null : snapshot } })
  const reader = createPublicPeopleReader({ readPublishedSnapshot: read })
  const profileId = signupProfileId(owner), first = await reader.profile({ id: profileId })
  assert.equal(first.profile.headline, 'Engineer'); assert.equal(first.profile.presence, 'member')
  imports = [{ id, owner, revision: 1 }]
  const next = await reader.profile({ id: profileId }); assert.equal(next.profile.headline, 'Export wins'); assert.equal(next.profile.connections.length, 1)
  assert.deepEqual(await reader.profile({ id: 'member-import-' + id }), { moved: profileId })
  assert.equal((await read()).profiles.length, 2); assert.equal(snapshot.profiles[0].id, 'member-import-' + id)
  if (process.env.UNLINKED_TEST_EVIDENCE_DIR) {
    await mkdir(process.env.UNLINKED_TEST_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.UNLINKED_TEST_EVIDENCE_DIR, 'export-profile-precedence.json'), JSON.stringify({
      beforeExport: first, afterExport: next,
      oldImportAddress: await reader.profile({ id: 'member-import-' + id }),
      immutableImportProfileId: snapshot.profiles[0].id,
    }, null, 2))
  }
  imports = []; assert.equal((await reader.profile({ id: profileId })).profile.headline, 'Engineer')
  f.store.setActive(false); assert.equal(await reader.profile({ id: profileId }), null)
})


test('deletion erases account profile state, preserves successful quota and fences other owners', async () => {
  const f = fixture(), other = { ownerId: 'owner-b', userId: 'user-b' }
  await f.lookup(); await f.service.confirm({ owner, slug: 'ceyda-kıran' })
  await f.lookup('ceyda-kıran', other); await f.service.confirm({ owner: other, slug: 'ceyda-kıran' })
  await f.service.removeOwner(owner); await f.service.removeOwner(owner)
  assert.equal(await f.service.read(owner), null)
  assert.equal((await f.service.list()).length, 1); assert.ok(await f.service.read(other))
  const key = signupProfileId(owner).slice('member-linkedin-'.length)
  assert.deepEqual(f.store.accounts.get(key), { attempts: 1, succeeded: true })
  f.advance(86400000)
  const fresh = createSignupLinkedin({ store: f.store, config: unipileConfig(env), fetchImpl: async () => { throw Error('must not fetch') } })
  for (const slug of ['ceyda-kıran', 'another']) assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/' + slug })).code, 'account_limit')
  await assert.rejects(fresh.confirm({ owner, slug: 'ceyda-kıran' }), /self_claim_conflict/)
  assert.equal(f.calls.length, 1)
})

test('deleting an unfinished lookup prevents late completion from restoring retained profile data', async () => {
  let release
  const f = fixture({ fetchImpl: () => new Promise(resolve => { release = () => resolve(Response.json(payload)) }) })
  const pending = f.lookup()
  await new Promise(resolve => setImmediate(resolve))
  await f.service.removeOwner(owner)
  release(); assert.equal((await pending).code, 'storage_unavailable')
  assert.deepEqual([...f.store.accounts.values()], [{ attempts: 1, succeeded: false }])
  assert.deepEqual(await f.service.list(), [])
})

test('legacy slug index normalizes once across concurrent and repeated encoded lookups', async () => {
  let loads = 0, iterations = 0
  const index = new Map([['ceyda-k%c4%b1ran', 'legacy-ceyda'], ['OTHER', 'legacy-other']])
  index[Symbol.iterator] = function* () { iterations++; yield* Map.prototype[Symbol.iterator].call(this) }
  const claims = createSelfClaims({ driver: {}, publicPeople: { read: async () => ({ profiles: [{ id: 'legacy-ceyda', name: 'Ceyda Kıran' }] }) },
    slugIndex: async () => { loads++; return index } })
  assert.deepEqual(await Promise.all(['ceyda-kıran', 'ceyda-k%C4%B1ran', 'OTHER'].map(claims.lookupSlug)), ['legacy-ceyda', 'legacy-ceyda', 'legacy-other'])
  for (let i = 0; i < 100; i++) assert.equal(await claims.lookupSlug('ceyda-kıran'), 'legacy-ceyda')
  assert.equal(await claims.lookupSlug('unknown'), null)
  assert.equal(await claims.lookupName('  Ceyda Kıran  '), 'legacy-ceyda')
  assert.equal(loads, 1); assert.equal(iterations, 1)
})

test('legacy slug index retries failed initialization', async () => {
  let loads = 0
  const claims = createSelfClaims({ driver: {}, publicPeople: { read: async () => null }, slugIndex: async () => {
    if (++loads === 1) throw Error('temporarily unavailable')
    return new Map([['encoded-%c4%b1', 'legacy-id']])
  } })
  assert.equal(await claims.lookupSlug('encoded-ı'), null)
  assert.equal(await claims.lookupSlug('encoded-ı'), 'legacy-id')
  assert.equal(await claims.lookupSlug('encoded-%C4%B1'), 'legacy-id')
  assert.equal(loads, 2)
})


test('deletion retains failed-attempt budgets across account sessions', async () => {
  const f = fixture({ fetchImpl: async () => new Response('', { status: 503 }) })
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.lookup()).code, 'provider_unavailable')
    await f.service.removeOwner(owner)
    f.advance(86400000)
  }
  assert.deepEqual([...f.store.accounts.values()], [{ attempts: 3, succeeded: false }])
  assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 3)
})
