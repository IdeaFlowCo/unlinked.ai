import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { accountGrantTools, CURRENT_ACCOUNT_GRANT_VERSION } from '../mcp-server/account-grants.mjs'
import { createSelfClaims } from '../mcp-server/self-claims.mjs'
import { groupConnectionRows } from '../mcp-server/connection-identity.mjs'
import { compareCodePoints, nameSortKey, orderNetwork } from '../src/utils/network-order.mjs'
import { linkedinSlug, normalizeLinkedinSlug, urlIdentityMerges } from '../src/utils/public-people/url-identity.mjs'

// unlinked-tto.1 (one entry per person, sources[]), unlinked-tto.2 (sort) and
// unlinked-ade (percent-encoded non-ASCII slugs in the legacy index).
const sha = value => createHash('sha256').update(value).digest('hex')
const owner = { ownerId: 'synthetic-dedupe-owner', userId: 'synthetic-dedupe-user' }
const row = (key, first, last, url, extra = {}) => ({ id: sha(key), ownerId: owner.ownerId, importId: sha('legacy-storage'), sourceId: sha('raw'), rowId: `Connections.csv#record=${key}`, category: 'connections',
  fields: { 'first name': first, 'last name': last, url, company: extra.company ?? '', position: extra.position ?? '', ...(extra.connected ? { 'connected on': extra.connected } : {}) }, provenance: { source: 'recovered-legacy-storage-v1' } })

// Imported rows. Emily and Nikhil are also reachable through a recorded public path.
const emily = row('emily', 'Emily Bei', 'Cheng', 'https://www.linkedin.com/in/emily-bei-cheng', { company: 'Synthetic Labs', position: 'Researcher', connected: '04 Oct 2021' })
const nikhil = row('nikhil', 'Nikhil', 'Gupta', 'https://www.linkedin.com/in/nikhil-g', { company: 'Acme', connected: '01 Jan 2024' })
const samOne = row('sam-1', 'Sam', 'Lee', 'https://www.linkedin.com/in/sam-lee-1', { company: 'Zeta' })
const samTwo = row('sam-2', 'Sam', 'Lee', 'https://www.linkedin.com/in/sam-lee-2', { company: 'Beta' })
const noUrlOne = row('nourl-1', 'Pat', 'Kim', '')
const noUrlTwo = row('nourl-2', 'Pat', 'Kim', '')
const rocket = row('rocket', '🚀 Zoe', 'Adams', 'https://www.linkedin.com/in/zoe-adams', { connected: '05 Oct 2026' })
const quoted = row('quoted', '"Bob"', 'Brown', 'https://www.linkedin.com/in/bob-brown')
const accented = row('accent', 'Émile', 'Zola', 'https://www.linkedin.com/in/emile-zola')
const lower = row('lower', 'alice', 'Cooper', 'https://www.linkedin.com/in/alice-cooper')
// unlinked-ade: the legacy index stores this slug percent-encoded.
const ceyda = row('ceyda', 'Ceyda', 'Kıran', 'https://www.linkedin.com/in/ceyda-k%C4%B1ran-9b192227')
// The same LinkedIn address imported twice (a re-import) is one person too.
const emilyAgain = { ...row('emily-again', 'Emily', 'Cheng', 'https://www.linkedin.com/in/Emily-Bei-Cheng/'), importedAt: Date.UTC(2026, 9, 1) }
const imported = [emily, nikhil, samOne, samTwo, noUrlOne, noUrlTwo, rocket, quoted, accented, lower, ceyda, emilyAgain]

const profile = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const snapshot = async () => ({ state: 'published', complete: true, revision: 'dedupe-fixture-v1',
  profiles: [profile('anchor', 'Owner Anchor'), profile('legacy-emily', 'Emily Cheng', { headline: 'Public headline' }), profile('legacy-nikhil', 'Nikhil Gupta'), profile('legacy-ceyda', 'Ceyda Kıran'), profile('legacy-other', 'Someone Else')],
  // A merged profile: its old address points at the survivor.
  aliases: { 'legacy-nikhil-old': 'legacy-nikhil' },
  connections: ['legacy-emily', 'legacy-nikhil', 'legacy-ceyda', 'legacy-other'].map(toId => ({ fromId: 'anchor', toId })) })
const anchor = { profileId: 'anchor', receiptId: 'receipt', revision: 'legacy-public-v1:synthetic', sourceSha256: 'synthetic' }
async function backend() {
  const published = await snapshot()
  return {
    listImportIds: async () => [],
    readLegacyObservations: async () => ({ assertions: imported }),
    readLegacyProfile: async () => ({ ...anchor, profile: published.profiles[0], profiles: published.profiles, connections: published.connections }),
  }
}
// The recovered legacy index, with Ceyda's key percent-encoded as in the manifests.
const slugIndex = async () => new Map([['emily-bei-cheng', 'legacy-emily'], ['nikhil-g', 'legacy-nikhil-old'], ['ceyda-k%c4%b1ran-9b192227', 'legacy-ceyda']])
const selfClaims = createSelfClaims({ driver: {}, publicPeople: { read: async () => null }, slugIndex })
const service = createAccountToolService({ getBackend: async () => backend(), readPublishedSnapshot: snapshot, lookupSlug: slug => selfClaims.lookupSlug(slug) })
const grant = { ...owner, scope: 'owner_network_and_public', version: CURRENT_ACCOUNT_GRANT_VERSION, tools: [...accountGrantTools(CURRENT_ACCOUNT_GRANT_VERSION, 'owner_network_and_public')] }
const list = async (input = {}) => (await service.call({ grant, name: 'unlinked_list_connections', input })).result
const everything = async input => {
  const pages = []
  let page = await list({ ...input, limit: 5 })
  pages.push(...page.connections)
  while (page.nextCursor) { page = await list({ ...input, limit: 5, cursor: page.nextCursor }); pages.push(...page.connections) }
  return { total: page.total, connections: pages }
}

test('an imported person and their recorded public path are one entry with both sources', async () => {
  const { total, connections } = await everything({})
  const found = connections.filter(entry => entry.sources.some(source => source.provenance.type === 'owner_import' && source.id === emily.id))
  assert.equal(found.length, 1)
  const [person] = found
  // Top-level fields are the owner import's, never the public copy's.
  assert.equal(person.id, emily.id)
  assert.equal(person.name, 'Emily Bei Cheng')
  assert.equal(person.company, 'Synthetic Labs')
  assert.equal(person.headline, 'Researcher')
  assert.equal(person.provenance.type, 'owner_import')
  assert.equal(person.visibility, 'owner_private')
  assert.equal(person.publishedProfileId, 'legacy-emily')
  assert.equal(person.linkedinRefHash, sha('emily-bei-cheng'))
  assert.equal(person.connectedAt, '2021-10-04T00:00:00.000Z')
  // The re-import and the public path are sources; the earliest import is primary.
  assert.deepEqual(person.sources.map(source => [source.provenance.type, source.name, source.visibility]), [
    ['owner_import', 'Emily Bei Cheng', 'owner_private'], ['owner_import', 'Emily Cheng', 'owner_private'], ['recorded_public_path', 'Emily Cheng', 'public']])
  assert.deepEqual(person.sources[2].provenance.path, { fromId: 'anchor', toId: 'legacy-emily' })
  // A merged legacy id (the slug index names the old id) follows the merge.
  const gupta = connections.filter(entry => entry.name.startsWith('Nikhil'))
  assert.equal(gupta.length, 1)
  assert.equal(gupta[0].sources.length, 2)
  assert.equal(gupta[0].publishedProfileId, 'legacy-nikhil')
  // total counts people: 12 imported rows + 4 recorded paths, minus 1 re-import and 3 joined paths.
  assert.equal(total, 12)
  assert.equal(connections.length, 12)
  assert.equal(new Set(connections.map(entry => entry.id)).size, 12)
})

test('the same name is never evidence: different people stay separate', async () => {
  const { connections } = await everything({})
  const sams = connections.filter(entry => entry.name === 'Sam Lee')
  assert.equal(sams.length, 2)
  assert.deepEqual(sams.map(entry => entry.sources.length), [1, 1])
  const pats = connections.filter(entry => entry.name === 'Pat Kim')
  assert.equal(pats.length, 2)
  // A recorded path to an unrelated public profile stays its own entry.
  assert.equal(connections.filter(entry => entry.name === 'Someone Else').length, 1)
})

test('a percent-encoded non-ASCII legacy slug joins its decoded import (unlinked-ade)', async () => {
  assert.equal(normalizeLinkedinSlug('ceyda-k%c4%b1ran-9b192227'), linkedinSlug('https://www.linkedin.com/in/ceyda-k%C4%B1ran-9b192227'))
  assert.equal(normalizeLinkedinSlug('100%-not-encoding'), '100%-not-encoding')
  assert.equal(await selfClaims.lookupSlug('ceyda-kıran-9b192227'), 'legacy-ceyda')
  const { connections } = await everything({})
  const found = connections.filter(entry => entry.name.startsWith('Ceyda'))
  assert.equal(found.length, 1)
  assert.equal(found[0].publishedProfileId, 'legacy-ceyda')
  assert.deepEqual(found[0].sources.map(source => source.provenance.type), ['owner_import', 'recorded_public_path'])
  // The automatic URL merge sees the same address despite the encoded index key.
  const merges = urlIdentityMerges({ rows: [{ publicId: 'public-x', subject: 'https://www.linkedin.com/in/ceyda-k%C4%B1ran-9b192227' }, { publicId: 'public-y', subject: 'https://www.linkedin.com/in/ceyda-kıran-9b192227' }],
    slugIndex: new Map([['CEYDA-K%C4%B1RAN-9B192227', 'legacy-ceyda']]) })
  assert.deepEqual(merges.map(merge => [merge.profileId, merge.survivorId]), [['public-x', 'legacy-ceyda'], ['public-y', 'legacy-ceyda']])
})

test('grouping "none" returns one row per source record in the historical shape', async () => {
  const { total, connections } = await everything({ grouping: 'none' })
  assert.equal(total, 16)
  const emilies = connections.filter(entry => [emily.id, emilyAgain.id].includes(entry.id) || entry.provenance.path?.toId === 'legacy-emily')
  assert.equal(emilies.length, 3)
  for (const entry of connections) {
    assert.equal(entry.sources, undefined)
    assert.deepEqual(Object.keys(entry).filter(key => !['id', 'name', 'headline', 'company', 'linkedinUrl', 'provenance', 'visibility'].includes(key)), [])
  }
})

test('default name order ignores leading emoji and punctuation, accents and case; names are shown as written', async () => {
  assert.equal(nameSortKey('🚀 Zoe Adams'), 'Zoe Adams')
  assert.equal(nameSortKey('"Bob" Brown'), 'Bob" Brown')
  const names = (await everything({})).connections.map(entry => entry.name)
  // Accent-insensitive: "Émile" sorts as "emile", before "emily".
  const wanted = ['alice Cooper', '"Bob" Brown', 'Ceyda Kıran', 'Émile Zola', 'Emily Bei Cheng', 'Nikhil Gupta', 'Pat Kim', 'Pat Kim', 'Sam Lee', 'Sam Lee', 'Someone Else', '🚀 Zoe Adams']
  assert.deepEqual(names, wanted)
  const desc = (await everything({ sort: 'name-desc' })).connections.map(entry => entry.name)
  assert.equal(desc[0], '🚀 Zoe Adams'); assert.equal(desc.at(-1), 'alice Cooper')
})

test('raw keeps true code-point order of the name as written', async () => {
  const names = (await everything({ sort: 'raw' })).connections.map(entry => entry.name)
  assert.deepEqual(names, [...names].sort(compareCodePoints))
  assert.equal(names[0], '"Bob" Brown')
  assert.equal(names.at(-1), '🚀 Zoe Adams')
  assert.ok(names.indexOf('alice Cooper') > names.indexOf('Sam Lee'), 'lowercase after uppercase')
  // Astral characters compare by code point, not UTF-16 unit.
  assert.equal(compareCodePoints('\u{1F680}', 'Ａ'), 1)
  assert.equal(compareCodePoints('ab', 'a'), 1)
  assert.equal(compareCodePoints('a', 'a'), 0)
})

test('connected, imported and company orders', async () => {
  const connected = (await everything({ sort: 'connected' })).connections
  assert.deepEqual(connected.slice(0, 3).map(entry => entry.name), ['🚀 Zoe Adams', 'Nikhil Gupta', 'Emily Bei Cheng'])
  // People without a date follow, in name order.
  assert.equal(connected[3].name, 'alice Cooper')
  const importedFirst = (await everything({ sort: 'imported' })).connections
  assert.equal(importedFirst[0].name, 'Emily Bei Cheng')
  assert.equal(importedFirst[0].importedAt, '2026-10-01T00:00:00.000Z')
  const byCompany = (await everything({ sort: 'company' })).connections.map(entry => [entry.company ?? null, entry.name])
  assert.deepEqual(byCompany.slice(0, 4), [['Acme', 'Nikhil Gupta'], ['Beta', 'Sam Lee'], ['Synthetic Labs', 'Emily Bei Cheng'], ['Zeta', 'Sam Lee']])
  assert.equal(byCompany[4][0], null)
})

test('the cursor is bound to sort, grouping and query', async () => {
  const first = await list({ limit: 5 })
  assert.equal(first.sort, 'name'); assert.equal(first.grouping, 'person')
  for (const input of [{ sort: 'raw' }, { grouping: 'none' }, { q: 'sam' }])
    await assert.rejects(list({ ...input, limit: 5, cursor: first.nextCursor }), error => error.code === 'cursor_invalid')
  const again = await list({ limit: 5, cursor: first.nextCursor })
  assert.equal(again.connections.length, 5)
  await assert.rejects(list({ sort: 'best' }), error => error.code === 'invalid_input')
  await assert.rejects(list({ grouping: 'all' }), error => error.code === 'invalid_input')
})

test('a query matches any grouped source; total counts matching people', async () => {
  // The public copy's headline finds the person; the entry still shows the import's.
  const result = await list({ q: 'public headline' })
  assert.equal(result.total, 1)
  assert.equal(result.connections[0].id, emily.id)
  assert.equal(result.connections[0].headline, 'Researcher')
  const cheng = await list({ q: 'cheng' })
  assert.equal(cheng.total, 1)
  assert.equal(cheng.connections[0].sources.length, 3)
})

test('without the published index, recorded ids and LinkedIn addresses still group', async () => {
  const rows = [emily, emilyAgain, samOne]
  const entries = rows.map(value => ({ id: value.id, provenance: { type: 'owner_import' } }))
  const { groups, published } = await groupConnectionRows(rows, entries, { lookup: async () => { throw new Error('index down') } })
  assert.deepEqual(groups.map(indexes => indexes.map(index => rows[index].id)), [[emily.id, emilyAgain.id], [samOne.id]])
  assert.deepEqual(published, [null, null, null])
})

test('unlinked_list_people accepts name, name-desc and raw orders', async () => {
  const people = async sort => (await service.call({ grant, name: 'unlinked_list_people', input: sort ? { sort } : {} })).result
  const best = await people()
  assert.equal(best.sort, undefined)
  const raw = await people('raw')
  assert.equal(raw.sort, 'raw')
  assert.deepEqual(raw.profiles.map(value => value.name), [...raw.profiles.map(value => value.name)].sort(compareCodePoints))
  const desc = await people('name-desc')
  assert.equal(desc.profiles[0].name, 'Someone Else')
  assert.deepEqual(orderNetwork([{ id: 'b', name: '🚀 B' }, { id: 'a', name: 'a' }], 'name').map(value => value.id), ['a', 'b'])
})
