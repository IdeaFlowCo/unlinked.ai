import { memorySignupStore } from './helpers/signup-profile-store.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSignupProfileLookup, profileLookupSettings, loadProfileLookupAdapter, prepareProfileLookup, signupProfileSlug, normalizeLookupProfile, signupProfileId, ProfileLookupError, PROFILE_LOOKUP_ROOT } from '../mcp-server/signup-profile-lookup.mjs'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { createMemberPublicIndex, projectPublicMemberImport, ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { PUBLIC_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const owner = { ownerId: 'owner-a', userId: 'user-a' }
const env = { UNLINKED_PROFILE_LOOKUP_ADAPTER: PROFILE_LOOKUP_ROOT + 'profile-lookup-adapter.mjs' }
// Fake adapter output in the contract shape, plus fields that must be dropped.
const payload = { name: 'Ceyda Kıran', headline: 'Engineer', location: 'Istanbul', about: 'Public bio', photo: 'data:image/png;secret', email: 'private@example.invalid', identifier: 'internal-id',
  positions: [{ title: 'Engineer', company: 'Example', startDate: 'Apr 2025', email: 'private@example.invalid' }, { title: 'missing company' }], education: [{ institution: 'Example University', degree: 'BS' }], skills: ['Sailing'] }

function fixture({ lookupImpl = async () => structuredClone(payload), settings = profileLookupSettings(env) } = {}) {
  let time = 100000
  const store = memorySignupStore(), calls = []
  const adapter = { lookup: async (...args) => { calls.push(args); return lookupImpl(...args) } }
  const service = createSignupProfileLookup({ store, settings, adapter, now: () => time })
  return { store, calls, service, advance: ms => { time += ms }, lookup: (slug = 'ceyda-kıran', who = owner) => service.lookup({ owner: who, address: 'https://www.linkedin.com/in/' + slug }) }
}

test('strict URL normalizer accepts Unicode and encoded slugs, rejects arbitrary hosts, paths and schemes', async () => {
  for (const address of ['https://linkedin.com/in/ceyda-kıran/', 'linkedin.com/in/ceyda-k%C4%B1ran', 'https://www.linkedin.com/in/CEYDA-KIRAN']) assert.ok(signupProfileSlug(address))
  assert.equal(signupProfileSlug('linkedin.com/in/ceyda-k%C4%B1ran'), 'ceyda-kıran')
  for (const suffix of ['', '?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app', '#profile']) assert.equal(signupProfileSlug('https://www.linkedin.com/in/felipe-contreras-a353a3189/' + suffix), 'felipe-contreras-a353a3189')
  for (const address of ['ceyda-kiran', 'https://evil.test/linkedin.com/in/ceyda', 'https://linkedin.com.evil.test/in/x', 'http://linkedin.com/in/x', 'https://linkedin.com/in/x/extra', 'https://linkedin.com/in/%2Fbad', 'https://linkedin.com/in/%ZZ', 'https://name@linkedin.com/in/x', 'https://linkedin.com:123/in/x']) assert.equal(signupProfileSlug(address), null, address)
  const f = fixture(); assert.equal((await f.service.lookup({ owner, address: 'evil.test/linkedin.com/in/x' })).code, 'invalid_url'); assert.equal(f.calls.length, 0)
  const claims = createSelfClaims({ driver: {}, publicPeople: { read: async () => null }, slugIndex: async () => new Map([['ceyda-k%c4%b1ran-9b192227', 'legacy-ceyda']]) })
  assert.equal(await claims.lookupSlug('ceyda-kıran-9b192227'), 'legacy-ceyda')
  assert.equal(await claims.lookupSlug('ceyda-k%C4%B1ran-9b192227'), 'legacy-ceyda')
})

test('configuration is default off, pins the adapter under the private root and validates caps/pacing', async () => {
  assert.equal(profileLookupSettings({}), null)
  assert.equal(profileLookupSettings({ UNLINKED_PROFILE_LOOKUP_ADAPTER: '' }), null)
  assert.deepEqual(profileLookupSettings(env), { adapterPath: env.UNLINKED_PROFILE_LOOKUP_ADAPTER, dailyCap: 150, pacingMs: 4000, timeoutMs: 12000 })
  for (const adapterPath of ['relative/adapter.mjs', '/srv/elsewhere/adapter.mjs', PROFILE_LOOKUP_ROOT, PROFILE_LOOKUP_ROOT + '../wiring.mjs', PROFILE_LOOKUP_ROOT + 'a//b.mjs', '/srv/unlinked-private-guest-pilot-20261001/runtime/private-other/adapter.mjs']) {
    assert.equal(profileLookupSettings({ UNLINKED_PROFILE_LOOKUP_ADAPTER: adapterPath }), null, adapterPath)
  }
  for (const change of [{ UNLINKED_PROFILE_LOOKUP_PACING_MS: '3999' }, { UNLINKED_PROFILE_LOOKUP_DAILY_CAP: '-1' }, { UNLINKED_PROFILE_LOOKUP_DAILY_CAP: '1001' }, { UNLINKED_PROFILE_LOOKUP_TIMEOUT_MS: 'Infinity' }, { UNLINKED_PROFILE_LOOKUP_TIMEOUT_MS: '999' }]) assert.equal(profileLookupSettings({ ...env, ...change }), null)
  assert.equal(profileLookupSettings({ ...env, UNLINKED_PROFILE_LOOKUP_DAILY_CAP: '0' }).dailyCap, 0)
  const f = fixture({ settings: null }); assert.equal((await f.lookup()).code, 'disabled'); assert.equal(f.calls.length, 0)
  const missing = createSignupProfileLookup({ store: memorySignupStore(), settings: profileLookupSettings(env), adapter: null })
  assert.equal((await missing.lookup({ owner, address: 'https://www.linkedin.com/in/someone' })).code, 'disabled')
})

test('adapter loads once only from an owner-only regular file under the private root', async t => {
  const root = (await realpath(await mkdtemp(join(tmpdir(), 'profile-lookup-')))) + '/'
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = 'export default { async lookup(slug) { return { name: "Adapter " + slug } } }\n'
  const path = root + 'adapter.mjs', settings = { adapterPath: path, dailyCap: 1, pacingMs: 4000, timeoutMs: 1000 }
  await writeFile(path, source, { mode: 0o600 }); await chmod(path, 0o600)
  const adapter = await loadProfileLookupAdapter(settings, { root })
  assert.deepEqual(await adapter.lookup('x', {}), { name: 'Adapter x' })
  assert.equal(await loadProfileLookupAdapter(null, { root }), null)
  await chmod(path, 0o400); assert.ok(await loadProfileLookupAdapter(settings, { root }))
  for (const mode of [0o640, 0o604, 0o700, 0o000]) { await chmod(path, mode); await assert.rejects(loadProfileLookupAdapter(settings, { root }), /profile_lookup_adapter_permissions/) }
  await chmod(path, 0o600)
  await assert.rejects(loadProfileLookupAdapter(settings, { root, uid: process.getuid() + 1 }), /profile_lookup_adapter_permissions/)
  await assert.rejects(loadProfileLookupAdapter(settings, { root: root + 'nested/' }), /profile_lookup_adapter_path/)
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'absent.mjs' }, { root }), /profile_lookup_adapter_missing/)
  await symlink(path, root + 'link.mjs')
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'link.mjs' }, { root }), /profile_lookup_adapter_path/)
  await mkdir(root + 'real'); await writeFile(root + 'real/adapter.mjs', source, { mode: 0o600 }); await symlink(root + 'real', root + 'via')
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'via/adapter.mjs' }, { root }), /profile_lookup_adapter_path/)
  await mkdir(root + 'dir.mjs', { mode: 0o700 })
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'dir.mjs' }, { root }), /profile_lookup_adapter_path/)
  await writeFile(root + 'empty.mjs', 'export const other = 1\n', { mode: 0o600 })
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'empty.mjs' }, { root }), /profile_lookup_adapter_contract/)
  await writeFile(root + 'broken.mjs', 'throw new Error("secret-key")\n', { mode: 0o600 })
  await assert.rejects(loadProfileLookupAdapter({ ...settings, adapterPath: root + 'broken.mjs' }, { root }), error => error.message === 'profile_lookup_adapter_import')
  await writeFile(root + 'named.mjs', 'export async function lookup() { return null }\n', { mode: 0o600 })
  assert.equal(await (await loadProfileLookupAdapter({ ...settings, adapterPath: root + 'named.mjs' }, { root })).lookup('x', {}), null)
})

test('startup wiring loads the adapter once and stays off with one fixed-code line on any failure', async () => {
  const lines = [], log = line => lines.push(line)
  let loads = 0
  const adapter = { lookup: async () => null }
  assert.deepEqual(await prepareProfileLookup({ env: {}, load: async () => { loads++ }, log }), { settings: null, adapter: null })
  assert.equal(loads, 0); assert.deepEqual(lines, [])
  const ready = await prepareProfileLookup({ env, load: async settings => { loads++; assert.equal(settings.adapterPath, env.UNLINKED_PROFILE_LOOKUP_ADAPTER); return adapter }, log })
  assert.equal(ready.adapter, adapter); assert.equal(ready.settings.dailyCap, 150); assert.equal(loads, 1)
  assert.deepEqual(await prepareProfileLookup({ env: { UNLINKED_PROFILE_LOOKUP_ADAPTER: '/tmp/adapter.mjs' }, load: async () => { loads++ }, log }), { settings: null, adapter: null })
  assert.deepEqual(await prepareProfileLookup({ env, load: async () => { throw Error('profile_lookup_adapter_permissions') }, log }), { settings: null, adapter: null })
  assert.deepEqual(await prepareProfileLookup({ env, load: async () => { throw Error('secret-key at /srv/x') }, log }), { settings: null, adapter: null })
  assert.equal(loads, 1)
  assert.deepEqual(lines, ['profile_lookup_disabled: invalid UNLINKED_PROFILE_LOOKUP_* configuration', 'profile_lookup_disabled: profile_lookup_adapter_permissions', 'profile_lookup_disabled: profile_lookup_adapter_unavailable'])
  const off = createSignupProfileLookup({ store: memorySignupStore(), ...await prepareProfileLookup({ env, load: async () => { throw Error('x') } }) })
  assert.equal((await off.lookup({ owner, address: 'https://www.linkedin.com/in/someone' })).code, 'disabled')
})

test('one read maps only professional fields, cached repeats never look up again, and confirmation alone publishes a self-asserted source', async () => {
  const f = fixture(), result = await f.lookup()
  assert.equal(result.status, 'found'); assert.equal(result.profile.name, 'Ceyda Kıran')
  assert.equal(result.profile.positions[0].startDate, 'Apr 2025'); assert.equal(result.profile.education[0].institution, 'Example University')
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('data:')); assert.ok(!JSON.stringify(result).includes('internal-id'))
  assert.deepEqual(result.profile.skills, ['Sailing']); assert.equal(result.profile.positions.length, 1); assert.equal(result.profile.company, 'Example')
  const [slug, options] = f.calls[0]
  assert.equal(slug, 'ceyda-kıran'); assert.deepEqual(Object.keys(options), ['signal']); assert.ok(options.signal instanceof AbortSignal)
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
  const f = fixture({ settings: profileLookupSettings({ ...env, UNLINKED_PROFILE_LOOKUP_DAILY_CAP: '2' }), lookupImpl: async () => { throw new ProfileLookupError('unavailable') } })
  const other = { ownerId: 'owner-b', userId: 'user-b' }
  assert.equal((await f.lookup()).code, 'lookup_unavailable')
  f.advance(3999); assert.equal((await f.lookup('other', other)).code, 'paced'); assert.equal(f.calls.length, 1)
  f.advance(1); assert.equal((await f.lookup('other', other)).code, 'lookup_unavailable')
  f.advance(4000); assert.equal((await f.lookup()).code, 'daily_cap'); assert.equal(f.calls.length, 2)
  f.advance(86400000); assert.equal((await f.lookup()).code, 'lookup_unavailable')
  f.advance(4000); assert.equal((await f.lookup()).code, 'lookup_unavailable')
  f.advance(86400000); assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 4)
})

test('concurrent requests and in-flight reads cannot bypass the account or global gate', async () => {
  let release
  const f = fixture({ lookupImpl: () => new Promise(resolve => { release = () => resolve(payload) }) })
  const pending = f.lookup()
  await new Promise(resolve => setImmediate(resolve))
  f.advance(5000)
  assert.equal((await f.lookup()).code, 'paced')
  assert.equal((await f.lookup('other', { ownerId: 'owner-b', userId: 'user-b' })).code, 'paced')
  assert.equal(f.calls.length, 1); release(); assert.equal((await pending).status, 'found')
})

test('typed failures hide adapter contents and allow only two retries, with no successful response published automatically', async () => {
  const secret = code => Object.assign(Error('secret-key raw details'), { code })
  for (const [lookupImpl, code] of [[async () => { throw new DOMException('secret-key raw details', 'TimeoutError') }, 'timeout'], [async () => { throw secret('timeout') }, 'timeout'],
    [async () => { throw new ProfileLookupError('refused') }, 'lookup_refused'], [async () => { throw secret('refused') }, 'lookup_refused'], [async () => { throw secret('unavailable') }, 'lookup_unavailable'],
    [async () => { throw Error('secret-key') }, 'lookup_unavailable'], [() => { throw Error('secret-key sync') }, 'lookup_unavailable'], [async () => ({ email: 'secret-key' }), 'lookup_unavailable'],
    [async () => 'secret-key', 'lookup_unavailable'], [async () => null, 'not_found']]) {
    const f = fixture({ lookupImpl })
    for (let i = 0; i < 3; i++) { const result = await f.lookup(); assert.equal(result.status, 'unavailable'); assert.equal(result.code, code); assert.ok(!JSON.stringify(result).includes('secret-key')); f.advance(4000) }
    assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 3)
    assert.deepEqual(await f.service.list(), [])
  }
  assert.throws(() => normalizeLookupProfile({}), /invalid_profile/)
  assert.throws(() => normalizeLookupProfile({ name: '   ' }), /invalid_profile/)
  assert.equal(new ProfileLookupError('other').code, 'unavailable')
})

test('the lookup deadline holds even when an adapter ignores its abort signal', async t => {
  // The production HTTP server keeps the loop alive; AbortSignal.timeout does not.
  const serverLifetime = setInterval(() => {}, 1000)
  t.after(() => clearInterval(serverLifetime))
  let seen
  const f = fixture({ settings: profileLookupSettings({ ...env, UNLINKED_PROFILE_LOOKUP_TIMEOUT_MS: '1000' }), lookupImpl: (slug, { signal }) => { seen = signal; return new Promise(() => {}) } })
  const started = Date.now(), result = await f.lookup()
  assert.equal(result.code, 'timeout'); assert.ok(seen.aborted); assert.ok(Date.now() - started < 5000)
  assert.deepEqual([...f.store.accounts.values()].map(row => [row.attempts, row.pendingUntil]), [[1, 0]])
})

test('adapter output is bounded to whitelisted professional fields', () => {
  const long = 'x'.repeat(30000)
  const profile = normalizeLookupProfile({ name: ' Ada ', about: long, positions: Array.from({ length: 150 }, (_, i) => ({ title: 'T' + i, company: 'C', startDate: long })),
    education: [{ institution: 'U', degree: 'D', extra: 'drop' }, { degree: 'no school' }], skills: [...Array(600).fill('S'), 7, null], contact: { email: 'x@example.invalid' } })
  assert.equal(profile.name, 'Ada'); assert.equal(profile.about.length, 20000); assert.equal(profile.positions.length, 100); assert.equal(profile.positions[0].startDate.length, 80)
  assert.deepEqual(profile.education, [{ institution: 'U', degree: 'D' }]); assert.equal(profile.skills.length, 500)
  assert.deepEqual(Object.keys(profile).sort(), ['about', 'company', 'education', 'name', 'positions', 'skills'])
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
  f.advance(4000)
  await f.lookup('another-person', other); await f.service.confirm({ owner: other, slug: 'another-person' })
  await f.service.removeOwner(owner); await f.service.removeOwner(owner)
  assert.equal(await f.service.read(owner), null)
  assert.equal((await f.service.list()).length, 1); assert.ok(await f.service.read(other))
  const key = signupProfileId(owner).slice('member-signup-'.length)
  assert.deepEqual(f.store.accounts.get(key), { attempts: 1, succeeded: true })
  f.advance(86400000)
  const fresh = createSignupProfileLookup({ store: f.store, settings: profileLookupSettings(env), adapter: { lookup: async () => { throw Error('must not look up') } } })
  for (const slug of ['ceyda-kıran', 'another']) assert.equal((await fresh.lookup({ owner, address: 'https://linkedin.com/in/' + slug })).code, 'account_limit')
  await assert.rejects(fresh.confirm({ owner, slug: 'ceyda-kıran' }), /self_claim_conflict/)
  assert.equal(f.calls.length, 2)
})

test('one active account owns a slug: cached and stale candidates refuse, deletion releases it without resetting quotas', async () => {
  const f = fixture(), other = { ownerId: 'owner-b', userId: 'user-b' }, slug = 'ceyda-kıran'
  await f.lookup(slug); await f.lookup(slug, other)
  await f.service.confirm({ owner, slug })
  assert.equal((await f.lookup(slug, other)).code, 'slug_claimed')
  await assert.rejects(f.service.confirm({ owner: other, slug }), /self_claim_conflict/)
  assert.equal((await f.service.list()).length, 1); assert.equal(f.calls.length, 1)
  await f.service.removeOwner(owner)
  assert.equal((await f.lookup(slug, other)).status, 'found')
  await f.service.confirm({ owner: other, slug })
  assert.equal((await f.service.list())[0].profile.id, signupProfileId(other))
  assert.equal(f.calls.length, 1)
})

test('a slug claimed while a lookup is in flight suppresses its completed card and retains the lookup budget', async () => {
  let reads = 0, release
  const f = fixture({ lookupImpl: async () => ++reads === 1 ? payload : new Promise(resolve => { release = () => resolve(payload) }) })
  const other = { ownerId: 'owner-b', userId: 'user-b' }, slug = 'ceyda-kıran'
  await f.lookup(slug, other)
  f.store.cache.clear(); f.advance(4000)
  const pending = f.lookup(slug)
  await new Promise(resolve => setImmediate(resolve))
  await f.service.confirm({ owner: other, slug })
  release(); assert.equal((await pending).code, 'slug_claimed')
  await assert.rejects(f.service.confirm({ owner, slug }), /self_claim_conflict/)
  await f.service.removeOwner(other)
  assert.equal((await f.lookup('different')).code, 'account_limit')
  assert.equal(f.calls.length, 2)
})

test('inactive owners release a slug while active owners and retired owners cannot reconfirm over its new holder', async () => {
  const f = fixture(), other = { ownerId: 'owner-b', userId: 'user-b' }, slug = 'ceyda-kıran'
  await f.lookup(); await f.service.confirm({ owner, slug })
  f.store.setOwnerActive(owner, false)
  await f.lookup(slug, other); await f.service.confirm({ owner: other, slug })
  await assert.rejects(f.service.confirm({ owner, slug }), /self_claim_conflict/)
  const source = [...f.store.sources.values()].find(row => row.owner.ownerId === other.ownerId)
  source.retired = true
  f.store.setOwnerActive(owner, true)
  await assert.rejects(f.service.confirm({ owner, slug }), /self_claim_conflict/)
  await assert.rejects(f.service.confirm({ owner: other, slug }), /self_claim_conflict/)
  assert.equal((await f.service.list()).length, 0)
})

test('deleting an unfinished lookup prevents late completion from restoring retained profile data', async () => {
  let release
  const f = fixture({ lookupImpl: () => new Promise(resolve => { release = () => resolve(payload) }) })
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
  const f = fixture({ lookupImpl: async () => { throw new ProfileLookupError('unavailable') } })
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.lookup()).code, 'lookup_unavailable')
    await f.service.removeOwner(owner)
    f.advance(86400000)
  }
  assert.deepEqual([...f.store.accounts.values()], [{ attempts: 3, succeeded: false }])
  assert.equal((await f.lookup()).code, 'account_limit'); assert.equal(f.calls.length, 3)
})
