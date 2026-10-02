import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_COLUMNS } from '../src/utils/legacy-import/postgres-copy.mjs'
import { createLegacyPlan } from '../src/utils/legacy-import/legacy-plan.mjs'
import { createLegacyPublicProjection, LEGACY_PUBLIC_TRANSFORM_VERSION } from '../src/utils/public-people/legacy-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

const encode = value => value === null || value === undefined ? '\\N' : String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
function fixture() {
  const rows = {
    companies: [{ id: 'co', name: 'Example Company' }], institutions: [{ id: 'school', name: 'Example College' }],
    profiles: [{ id: 'a', user_id: 'opaque-unresolved-user', full_name: 'Synthetic Alice', headline: 'Builder', summary: 'Line one\nLine two' }, { id: 'b', full_name: 'Synthetic Bob' }],
    connections: [{ id: 'edge-ab', profile_id_a: 'a', profile_id_b: 'b' }],
    positions: [{ id: 'job', profile_id: 'a', company_id: 'co', title: 'Researcher', description: 'Works with data', started_on: '2020-01-01' }, { id: 'job-unknown', profile_id: 'b' }],
    education: [{ id: 'degree', profile_id: 'a', institution_id: 'school', degree_name: 'Design', started_on: '2015-01-01', finished_on: '2019-01-01' }, { id: 'degree-unknown', profile_id: 'b' }],
    skills: [{ id: 'skill', profile_id: 'a', name: 'Research' }], uploads: [{ id: 'upload', profile_id: 'a', file_name: 'excluded-private-file.zip', file_path: 'excluded-private/path.zip' }],
  }
  const source = Object.entries(LEGACY_COLUMNS).map(([table, columns]) => `COPY public.${table} (${columns.join(', ')}) FROM stdin;\n${rows[table].map(row => columns.map(column => encode(row[column])).join('\t') + '\n').join('')}\\.\n`).join('')
  return createLegacyPlan(source, { sourceContainerSha256: 'a'.repeat(64) })
}

test('complete public snapshot preserves fields, source IDs and directed edges through the real reader', async () => {
  const plan = fixture(), { snapshot, manifest } = createLegacyPublicProjection(plan)
  assert.deepEqual(snapshot.profiles, [
    { id: 'a', name: 'Synthetic Alice', headline: 'Builder', about: 'Line one\nLine two', positions: [{ title: 'Researcher', company: 'Example Company', startDate: '2020-01-01', description: 'Works with data' }], education: [{ institution: 'Example College', degree: 'Design', startDate: '2015-01-01', endDate: '2019-01-01' }], skills: ['Research'] },
    { id: 'b', name: 'Synthetic Bob', positions: [{ title: '', company: '' }], education: [{ institution: '' }], skills: [] },
  ])
  assert.deepEqual(snapshot.connections, [{ fromId: 'a', toId: 'b' }])
  assert.equal(snapshot.complete, true); assert.equal(snapshot.state, 'published')
  assert.equal(manifest.profiles[0].legacyUserId, 'opaque-unresolved-user')
  assert.equal(manifest.profiles[1].legacyUserId, null)
  assert.deepEqual(manifest.connections[0].provenance, { table: 'public.connections', rowOrdinal: 1 })
  assert.deepEqual(manifest.profiles[1].positions[0], { legacyId: 'job-unknown', legacyProfileId: 'b', legacyCompanyId: null, company: null, companyProvenance: null, title: null, startedOn: null, finishedOn: null, createdAt: null, provenance: { table: 'public.positions', rowOrdinal: 2 } })
  assert.equal(manifest.profiles[1].education[0].institution, null)
  assert.deepEqual(manifest.counts, plan.counts)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
  assert.deepEqual((await reader.list({ query: 'Example Company' })).profiles.map(value => value.id), ['a'])
  assert.deepEqual((await reader.profile({ id: 'a' })).profile.connections.map(value => value.id), ['b'])
  assert.deepEqual((await reader.profile({ id: 'b' })).profile.connections, [])
})

test('replay is deterministic, compact and immutable without mutating the source plan', () => {
  const plan = fixture(), original = structuredClone(plan), first = createLegacyPublicProjection(plan), second = createLegacyPublicProjection(plan)
  assert.deepEqual(first, second); assert.deepEqual(plan, original)
  assert.equal(first.snapshot.revision, `${LEGACY_PUBLIC_TRANSFORM_VERSION}:${plan.sourceSha256}`)
  assert.match(first.snapshot.revision, /^[\x00-\x7f]{1,128}$/)
  assert.equal(first.manifest.sourceContainerSha256, 'a'.repeat(64))
  assert.throws(() => first.snapshot.profiles.push({}), TypeError)
  assert.throws(() => { first.snapshot.profiles[0].positions[0].title = 'changed' }, TypeError)
  assert.throws(() => { first.manifest.profiles[0].legacyUserId = 'bound-owner' }, TypeError)
  plan.sourceSha256 = 'b'.repeat(64)
  assert.notEqual(createLegacyPublicProjection(plan).snapshot.revision, first.snapshot.revision)
  plan.sourceContainerSha256 = null
  assert.equal(createLegacyPublicProjection(plan).manifest.sourceContainerSha256, null)
})

test('whitelisting excludes private/auth fields and uploads while user provenance remains separate', () => {
  const plan = fixture()
  const extras = { email: 'excluded-email', phone: 'excluded-phone', privateNotes: 'excluded-notes', rawArchive: 'excluded-archive', ownerId: 'excluded-owner', encryptedPassword: 'excluded-password', auth: { token: 'excluded-token' } }
  Object.assign(plan, extras)
  for (const profile of plan.profiles) {
    Object.assign(profile, extras); Object.assign(profile.provenance, extras)
    for (const row of [...profile.positions, ...profile.education, ...profile.skills]) Object.assign(row, extras)
  }
  for (const row of [...plan.connections, ...plan.companies, ...plan.institutions, ...plan.uploads]) Object.assign(row, extras)
  const result = createLegacyPublicProjection(plan), serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /excluded-/)
  assert.doesNotMatch(JSON.stringify(result.snapshot), /legacyUserId|opaque-unresolved-user|provenance|filePath|filename/)
  assert.deepEqual(Object.keys(result.snapshot).sort(), ['complete', 'connections', 'profiles', 'revision', 'state'])
  assert.equal(result.manifest.profiles[0].legacyUserId, 'opaque-unresolved-user')
  assert.deepEqual(result.manifest.uploads[0], { legacyId: 'upload', legacyProfileId: 'a', createdAt: null, provenance: { table: 'public.uploads', rowOrdinal: 1 } })
})

test('incomplete, duplicate and dangling plans fail with data-free codes', () => {
  const malformed = [
    plan => { plan.counts.profiles++ },
    plan => { plan.counts.skills-- },
    plan => { plan.profiles.pop() },
    plan => { plan.issues.push({ secret: 'excluded-details' }) },
    plan => { plan.profiles[1].legacyId = plan.profiles[0].legacyId },
    plan => { plan.profiles[1].provenance.rowOrdinal = 1 },
    plan => { plan.connections[0].toLegacyProfileId = 'missing' },
    plan => { plan.profiles[0].positions[0].legacyProfileId = 'missing' },
    plan => { plan.profiles[0].positions[0].legacyCompanyId = 'missing' },
    plan => { plan.profiles[0].education[0].legacyInstitutionId = 'missing' },
    plan => { plan.uploads[0].legacyProfileId = 'missing' },
    plan => { plan.companies[0].provenance.table = 'auth.users' },
    plan => { plan.profiles[1].positions[0].company = 'Invented Organization' },
    plan => { plan.connections.push({ ...plan.connections[0], legacyId: 'another', provenance: { table: 'public.connections', rowOrdinal: 2 } }); plan.counts.connections++ },
  ]
  for (const change of malformed) {
    const plan = fixture(); change(plan)
    assert.throws(() => createLegacyPublicProjection(plan), error => /^legacy_public_[a-z_]+$/.test(error.message))
  }
})

test('reader cardinality, nested and text bounds fail without truncation', () => {
  for (const options of [{ maxProfiles: 1 }, { maxTextBytes: 1 }]) assert.throws(() => createLegacyPublicProjection(fixture(), options), /legacy_public_/)
  for (const options of [{ maxProfiles: 20001 }, { maxConnections: 100001 }, { maxTextBytes: 16777217 }, { maxProfiles: 0 }, { maxConnections: NaN }]) assert.throws(() => createLegacyPublicProjection(fixture(), options), /bound_invalid/)
  for (const [key, size] of [['profiles', 20001], ['connections', 100001]]) {
    const plan = fixture(); plan[key] = Array(size).fill(plan[key][0]); plan.counts[key] = size
    assert.throws(() => createLegacyPublicProjection(plan), /array_limit_or_invalid/)
  }
  for (const [key, size] of [['positions', 101], ['education', 101], ['skills', 501]]) {
    const plan = fixture(); plan.profiles[0][key] = Array(size).fill(plan.profiles[0][key][0])
    assert.throws(() => createLegacyPublicProjection(plan), /array_limit_or_invalid/)
  }
  const plan = fixture(); plan.profiles[0].about = 'x'.repeat(20001)
  assert.throws(() => createLegacyPublicProjection(plan), /text_invalid/)
})

test('malformed shape, IDs, hashes, required names and sparse arrays fail closed', () => {
  const mutations = [
    plan => { plan.sourceSha256 = 'invalid' }, plan => { plan.sourceContainerSha256 = 'invalid' },
    plan => { plan.profiles[0].legacyId = '..' }, plan => { plan.profiles[0].legacyId = 'x'.repeat(161) },
    plan => { plan.profiles[0].name = null }, plan => { plan.profiles[0].name = ' ' }, plan => { plan.profiles[0].about = {} },
    plan => { plan.profiles[0].positions = null }, plan => { delete plan.profiles[0] }, plan => { delete plan.connections[0] },
    plan => { plan.profiles[0].provenance.rowOrdinal = 0 }, plan => { plan.counts.positions = -1 },
  ]
  for (const change of mutations) { const plan = fixture(); change(plan); assert.throws(() => createLegacyPublicProjection(plan), /legacy_public_/) }
  for (const value of [undefined, null, [], 'private-data']) assert.throws(() => createLegacyPublicProjection(value), /record_invalid/)
  for (const target of ['profile', 'array']) {
    const plan = fixture(), value = target === 'profile' ? plan.profiles[0] : plan.profiles
    let calls = 0
    Object.defineProperty(value, target === 'profile' ? 'name' : '0', { get() { calls++; throw new Error('private-getter-error') } })
    assert.throws(() => createLegacyPublicProjection(plan), /legacy_public_/)
    assert.equal(calls, 0)
  }
})

test('reciprocal and self edges are retained only when explicitly present; empty complete plans work', async () => {
  const plan = fixture()
  for (const [legacyId, fromLegacyProfileId, toLegacyProfileId] of [['ba', 'b', 'a'], ['aa', 'a', 'a']]) plan.connections.push({ legacyId, fromLegacyProfileId, toLegacyProfileId, createdAt: null, provenance: { table: 'public.connections', rowOrdinal: plan.connections.length + 1 } })
  plan.counts.connections = plan.connections.length
  assert.deepEqual(createLegacyPublicProjection(plan).snapshot.connections, [{ fromId: 'a', toId: 'b' }, { fromId: 'b', toId: 'a' }, { fromId: 'a', toId: 'a' }])
  const empty = fixture()
  for (const key of ['profiles', 'connections', 'companies', 'institutions', 'uploads']) empty[key] = []
  for (const key of Object.keys(empty.counts)) empty.counts[key] = 0
  const { snapshot } = createLegacyPublicProjection(empty)
  const reader = createPublicPeopleReader({ readPublishedSnapshot: () => snapshot })
  assert.deepEqual(await reader.list(), { profiles: [] })
})
