import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, chmod, symlink, mkdir, readdir, stat, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPANY_DATASET, buildCompanyIndex, companyFacts, createCompanyFacts, validateCompanyRows } from '../mcp-server/company-metadata.mjs'
import { companyRevision, createNeo4jCompanyFactsStore } from '../mcp-server/company-facts-store.mjs'
import { prepareCompanyFacts, publishCompanyFacts, revokeCompanyFacts } from '../mcp-server/publish-company-facts.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const row = { name: 'Riot Games', tagline: 'Players first.', description: 'Makers of League of Legends.', industry: 'Computer Games', employeeCount: 9000, headquarters: 'Los Angeles, CA, US', founded: '2006', website: 'https://www.riotgames.com/', linkedinUrl: 'https://www.linkedin.com/company/riot-games/', aliases: ['Riot'] }
const fresh = { name: 'Fresh Co', linkedinUrl: 'https://www.linkedin.com/company/fresh-co' }
const bytes = value => Buffer.from(JSON.stringify(value))

test('company rows: the whitelist accepts reviewed rows and the static list itself', () => {
  assert.deepEqual(validateCompanyRows([row, fresh]), [row, fresh])
  assert.equal(validateCompanyRows([{ name: 'Only a name' }]).length, 1)
  assert.equal(validateCompanyRows([{ ...row, employeeCount: 0 }])[0].employeeCount, 0)
  const statics = [...new Set(buildCompanyIndex().values())]
  assert.equal(validateCompanyRows(statics).length, statics.length)
})

test('company rows: anything outside the whitelist is rejected', () => {
  const bad = [
    [], 'rows', [null], [[]], [{}], [{ name: '' }], [{ name: '   ' }], [{ name: 'x'.repeat(201) }], [{ name: '!!!' }],
    [{ ...row, logo: 'https://x.test/a.png' }], [{ ...row, description: 'x'.repeat(2001) }], [{ ...row, tagline: 'x'.repeat(2001) }],
    [{ ...row, employeeCount: -1 }], [{ ...row, employeeCount: 1.5 }], [{ ...row, employeeCount: '12' }], [{ ...row, founded: 2006 }],
    [{ ...row, website: 'http://www.riotgames.com/' }], [{ ...row, website: 'javascript:alert(1)' }], [{ ...row, website: 'https://user:pw@riot.test/' }],
    [{ ...row, linkedinUrl: 'http://www.linkedin.com/company/riot-games/' }], [{ ...row, linkedinUrl: 'https://www.linkedin.com/in/someone/' }],
    [{ ...row, linkedinUrl: 'https://evil.test/company/riot-games/' }], [{ ...row, linkedinUrl: 'https://www.linkedin.com/company/riot/games' }],
    [{ ...row, aliases: 'Riot' }], [{ ...row, aliases: [''] }], [{ ...row, aliases: [7] }],
    [row, { name: 'riot  games' }], [row, { name: 'Other', aliases: ['RIOT'] }], [{ ...row, aliases: [null] }],
    Array.from({ length: 5001 }, (_, index) => ({ name: `Company ${index}` })),
  ]
  for (const rows of bad) assert.throws(() => validateCompanyRows(rows), /company_row/, JSON.stringify(rows).slice(0, 120))
  assert.throws(() => validateCompanyRows([Object.assign(Object.create({ inherited: true }), { name: 'Proto' })]), /company_row_invalid/)
})

test('prepareCompanyFacts derives a content-addressed revision and rejects bad files', () => {
  const first = prepareCompanyFacts(bytes([row])), again = prepareCompanyFacts(Buffer.from(JSON.stringify([row], null, 2)))
  assert.equal(first.revision, again.revision)
  assert.match(first.revision, /^curated-companies-v1:[a-f0-9]{64}$/)
  assert.notEqual(first.sourceSha256, again.sourceSha256)
  assert.notEqual(first.revision, prepareCompanyFacts(bytes([{ ...row, tagline: 'Changed' }])).revision)
  for (const bad of [Buffer.from('not json'), Buffer.alloc(0), 'string', bytes({ name: 'object' })]) assert.throws(() => prepareCompanyFacts(bad))
})

test('graph rows win over the static list on any shared name or alias, and static aliases follow them', () => {
  const graphSmartcar = { name: 'Smartcar', tagline: 'Graph tagline' }
  const index = buildCompanyIndex([graphSmartcar, fresh])
  assert.equal(index.get('smartcar'), graphSmartcar)
  // The static Smartcar row's alias now reaches the published row, never the stale static facts.
  assert.equal(index.get('smartcar inc'), graphSmartcar)
  assert.equal(index.get('fresh co').name, 'Fresh Co')
  // A graph row named by a static alias supersedes that whole static company.
  const graphCassius = { name: 'Cassius', industry: 'Graph industry' }
  const byAlias = buildCompanyIndex([graphCassius])
  assert.equal(byAlias.get('cassius'), graphCassius)
  assert.equal(byAlias.get('cassius family'), graphCassius)
  assert.equal(byAlias.get('riot games').name, 'Riot Games')
  // An alias claimed by a different graph row stays with that row.
  const graphFamily = { name: 'Cassius Family', tagline: 'A different published company' }
  const split = buildCompanyIndex([graphCassius, graphFamily])
  assert.equal(split.get('cassius'), graphCassius); assert.equal(split.get('cassius family'), graphFamily)
})

test('runtime lookup merges the graph dataset, caches it for the TTL and returns copies', async () => {
  let clock = 0, reads = 0, dataset = { revision: 'r1', companies: [{ ...row, tagline: 'From the graph' }, fresh] }
  const lookup = createCompanyFacts({ readDataset: async () => { reads++; return dataset }, ttlMs: 60000, now: () => clock })
  assert.equal((await lookup('riot')).tagline, 'From the graph')
  assert.equal((await lookup('Fresh Co')).name, 'Fresh Co')
  assert.equal((await lookup('Smartcar, Inc.')).name, 'Smartcar')
  assert.equal(await lookup('Unknown Co'), null)
  const copy = await lookup('Riot Games'); copy.aliases.push('mutated'); copy.name = 'changed'
  assert.deepEqual((await lookup('Riot Games')).aliases, ['Riot'])
  assert.equal(reads, 1)
  dataset = null; clock = 59999
  assert.equal((await lookup('Riot Games')).tagline, 'From the graph')
  clock = 60000
  assert.equal((await lookup('Riot Games')).tagline, companyFacts('Riot Games').tagline)
  assert.equal(await lookup('Fresh Co'), null)
  assert.equal(reads, 2)
})

test('runtime lookup shares one in-flight read across concurrent pages', async () => {
  let reads = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const lookup = createCompanyFacts({ readDataset: async () => { reads++; await gate; return { revision: 'r', companies: [fresh] } } })
  const pending = Promise.all([lookup('Fresh Co'), lookup('Riot Games'), lookup('fresh co')])
  release()
  const [a, b, c] = await pending
  assert.equal(a.name, 'Fresh Co'); assert.equal(b.name, 'Riot Games'); assert.equal(c.name, 'Fresh Co')
  assert.equal(reads, 1)
})

test('a graph read error or invalid graph rows fall back to the static list without throwing', async () => {
  const errors = []
  let clock = 0
  const failing = createCompanyFacts({ readDataset: async () => { throw new Error('ServiceUnavailable') }, now: () => clock, onError: error => errors.push(error.message) })
  assert.deepEqual(await failing('Riot Games'), companyFacts('Riot Games'))
  assert.equal(await failing('Fresh Co'), null)
  // The fallback is cached too, so a down graph is not retried on every page view.
  await failing('Smartcar')
  assert.deepEqual(errors, ['ServiceUnavailable'])
  const invalid = createCompanyFacts({ readDataset: async () => ({ revision: 'r', companies: [{ name: 'Bad', website: 'javascript:alert(1)' }] }) })
  assert.equal(await invalid('Bad'), null)
  assert.equal((await invalid('Riot Games')).name, 'Riot Games')
  const throwingReporter = createCompanyFacts({ readDataset: async () => { throw new Error('down') }, onError: () => { throw new Error('reporter') } })
  assert.equal((await throwingReporter('Riot Games')).name, 'Riot Games')
  assert.equal((await createCompanyFacts()('smartcar inc')).name, 'Smartcar')
})

test('company routes serve graph-published facts and stay up when the graph read fails', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [{ id: 'max', name: 'Max Example', headline: 'Engineer at Riot Games', positions: [], education: [], skills: [] }], connections: [] }
  const options = lookupCompanyFacts => ({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a' }) }, resolveOwner: async () => ({ ownerId: 'owner-a', userId: 'user-a' }), getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot, lookupCompanyFacts })
  handler = createPrivateBrowserHandler(options(createCompanyFacts({ readDataset: async () => ({ revision: 'r', companies: [{ ...row, tagline: 'From the graph' }, fresh] }) })))
  const api = await (await fetch(`${endpoint}/api/companies/Riot%20Games`)).json()
  assert.equal(api.company.facts.tagline, 'From the graph'); assert.equal(api.company.total, 1)
  const page = await (await fetch(`${endpoint}/companies/Riot`)).text()
  assert.ok(page.includes('From the graph')); assert.ok(page.includes('href="https://www.riotgames.com/"'))
  const graphOnly = await fetch(`${endpoint}/companies/Fresh%20Co`)
  assert.equal(graphOnly.status, 200); assert.ok((await graphOnly.text()).includes('No one on Unlinked lists this company yet.'))
  handler = createPrivateBrowserHandler(options(createCompanyFacts({ readDataset: async () => { throw new Error('graph down') } })))
  const fallback = await fetch(`${endpoint}/api/companies/Smartcar`)
  assert.equal(fallback.status, 200); assert.equal((await fallback.json()).company.facts.name, 'Smartcar')
  assert.equal((await fetch(`${endpoint}/companies/Fresh%20Co`)).status, 404)
})

// In-memory stand-in with the graph store's publication semantics.
function memoryStore() {
  const revisions = new Map(), state = { pointer: null }
  return {
    state, revisions,
    async read() { return state.pointer ? { dataset: COMPANY_DATASET, revision: state.pointer, companies: structuredClone(revisions.get(state.pointer).companies) } : null },
    async publish(dataset, companies, sourceSha256, expected) {
      const revision = companyRevision(validateCompanyRows(companies)), prior = revisions.get(revision)
      if (prior?.state === 'deleted') throw new Error('company_revision_deleted')
      if (state.pointer !== expected && state.pointer !== revision) throw new Error('company_pointer_conflict')
      revisions.set(revision, { state: 'published', companies: structuredClone(companies) }); state.pointer = revision
      return { revision, companies: companies.length, replayed: prior?.state === 'published' }
    },
    async revoke(dataset, revision) {
      if (!revisions.has(revision)) throw new Error('company_revision_missing')
      revisions.get(revision).state = 'deleted'; if (state.pointer === revision) state.pointer = null
    },
  }
}

async function operatorRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'company-facts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await chmod(root, 0o700); await mkdir(join(root, 'audit'), { mode: 0o700 }); await mkdir(join(root, 'enrichment'), { mode: 0o700 })
  const rowsPath = join(root, 'enrichment', 'companies.json')
  await writeFile(rowsPath, JSON.stringify([row, fresh]), { mode: 0o600 })
  return { root, rowsPath }
}

test('publishCompanyFacts refuses foreign roots, relative paths, loose modes and symlinks', async t => {
  await assert.rejects(publishCompanyFacts({ rowsPath: '/srv/unlinked-private-guest-pilot-20261001/enrichment/companies.json', root: '/srv/other' }), /explicit_private_company_target_required/)
  await assert.rejects(publishCompanyFacts({ rowsPath: 'enrichment/companies.json', root: '/srv/unlinked-private-guest-pilot-20261001' }), /explicit_private_company_target_required/)
  await assert.rejects(publishCompanyFacts({ rowsPath: '/elsewhere/companies.json', root: '/srv/unlinked-private-guest-pilot-20261001' }), /explicit_private_company_target_required/)
  await assert.rejects(revokeCompanyFacts({ revision: companyRevision([row]), root: '/srv/other' }), /explicit_private_company_target_required/)
  const { root, rowsPath } = await operatorRoot(t)
  // The fixed host root is enforced unless a test passes its own.
  await assert.rejects(publishCompanyFacts({ rowsPath, root }), /explicit_private_company_target_required/)
  await assert.rejects(publishCompanyFacts({ rowsPath: `${root}/enrichment/../enrichment/companies.json`, root, allowedRoot: root }), /explicit_private_company_target_required/)
  await chmod(rowsPath, 0o644)
  await assert.rejects(publishCompanyFacts({ rowsPath, root, allowedRoot: root }), /private_company_source_required/)
  await chmod(rowsPath, 0o600)
  const link = join(root, 'enrichment', 'link.json'); await symlink(rowsPath, link)
  await assert.rejects(publishCompanyFacts({ rowsPath: link, root, allowedRoot: root }), /private_company_source_required/)
  await chmod(root, 0o755)
  await assert.rejects(publishCompanyFacts({ rowsPath, root, allowedRoot: root }), /private_company_source_required/)
  await chmod(root, 0o700)
  await writeFile(rowsPath, JSON.stringify([{ ...row, linkedinUrl: 'https://evil.test/' }]), { mode: 0o600 })
  await assert.rejects(publishCompanyFacts({ rowsPath, root, allowedRoot: root }), /company_row_invalid/)
})

test('plan mode prints the revision and digest and never opens the graph or writes', async t => {
  const { root, rowsPath } = await operatorRoot(t)
  const plan = await publishCompanyFacts({ rowsPath, root, allowedRoot: root, createStore: async () => { throw new Error('graph must not be opened in plan mode') } })
  assert.equal(plan.status, 'PLANNED_NO_WRITES'); assert.equal(plan.dataset, COMPANY_DATASET); assert.equal(plan.companies, 2)
  assert.equal(plan.revision, companyRevision([row, fresh])); assert.match(plan.sourceSha256, /^[a-f0-9]{64}$/); assert.match(plan.datasetSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(await readdir(join(root, 'audit')), [])
})

test('execute publishes, reads back, writes a private receipt and the reported rollback restores the static list', async t => {
  const { root, rowsPath } = await operatorRoot(t)
  const store = memoryStore(), createStore = async () => store
  const report = await publishCompanyFacts({ rowsPath, root, allowedRoot: root, execute: true, createStore })
  assert.equal(report.status, 'PUBLISHED_COMPLETE'); assert.equal(report.previousRevision, null); assert.equal(report.replayed, false)
  assert.equal(store.state.pointer, report.revision)
  assert.deepEqual(report.rollback, { operation: 'createNeo4jCompanyFactsStore.revoke', dataset: COMPANY_DATASET, revision: report.revision, command: report.rollback.command })
  assert.match(report.rollback.command, new RegExp(`publish-company-facts\\.mjs --revoke ${report.revision} ${root}$`))
  const [receipt] = await readdir(join(root, 'audit'))
  assert.equal((await stat(join(root, 'audit', receipt))).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(join(root, 'audit', receipt), 'utf8')).revision, report.revision)
  const lookup = createCompanyFacts({ readDataset: () => store.read(), ttlMs: 0 })
  assert.equal((await lookup('Fresh Co')).name, 'Fresh Co')
  // A second rows file moves the pointer forward from the revision it saw.
  await writeFile(rowsPath, JSON.stringify([fresh]), { mode: 0o600 })
  const second = await publishCompanyFacts({ rowsPath, root, allowedRoot: root, execute: true, createStore })
  assert.equal(second.previousRevision, report.revision)
  const revoked = await revokeCompanyFacts({ revision: second.revision, root, allowedRoot: root, createStore })
  assert.equal(revoked.status, 'REVOKED'); assert.equal(revoked.wasLive, true); assert.equal(revoked.liveRevision, null)
  assert.equal(await lookup('Fresh Co'), null)
  assert.equal((await lookup('Riot Games')).tagline, companyFacts('Riot Games').tagline)
  assert.equal((await readdir(join(root, 'audit'))).length, 3)
  await assert.rejects(revokeCompanyFacts({ revision: 'not-a-revision', root, allowedRoot: root, createStore }), /company_revision_invalid/)
})

// Real graph (optional, like tests/session-store.test.mjs):
//   UNLINKED_TEST_NEO4J_URI=bolt://127.0.0.1:<port> UNLINKED_TEST_NEO4J_PASSWORD=... \
//   UNLINKED_TEST_NEO4J_DRIVER=/path/to/node_modules/neo4j-driver node --test tests/company-facts.test.mjs
const uri = process.env.UNLINKED_TEST_NEO4J_URI
const loopback = typeof uri === 'string' && /^bolt:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri)

test('real Neo4j company facts store: publish, replay, pointer fence, verified read, revoke', { skip: !loopback || !process.env.UNLINKED_TEST_NEO4J_DRIVER }, async t => {
  const neo4j = createRequire(import.meta.url)(process.env.UNLINKED_TEST_NEO4J_DRIVER)
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', process.env.UNLINKED_TEST_NEO4J_PASSWORD ?? ''))
  const clear = async () => { const session = driver.session(); try { await session.run(`MATCH (n) WHERE n:UnlinkedCompanyDataset OR n:UnlinkedCompanyRevision OR n:UnlinkedCompanyChunk DETACH DELETE n`) } finally { await session.close() } }
  t.after(async () => { await clear(); await driver.close() })
  const store = createNeo4jCompanyFactsStore(driver)
  await assert.rejects(store.read(), /company_store_unavailable/)
  await store.initialize(); await store.initialize(); await clear()
  assert.equal(await store.read(), null)
  const source = 'a'.repeat(64)
  // Enough long rows to need several 128 KiB chunks.
  const many = Array.from({ length: 450 }, (_, index) => ({ name: `Company ${index}`, description: `${index} `.repeat(400).slice(0, 2000), employeeCount: index }))
  const first = await store.publish(COMPANY_DATASET, many, source, null)
  assert.equal(first.replayed, false); assert.equal(first.companies, 450)
  const read = await store.read()
  assert.equal(read.revision, first.revision); assert.deepEqual(read.companies, many)
  const chunks = await driver.executeQuery('MATCH (c:UnlinkedCompanyChunk {dataset: $dataset, revision: $revision}) RETURN count(c) AS n', { dataset: COMPANY_DATASET, revision: first.revision })
  assert.ok(Number(chunks.records[0].get('n')) > 1)
  assert.equal((await store.publish(COMPANY_DATASET, many, source, null)).replayed, true)
  // A stale expected revision cannot move the pointer.
  await assert.rejects(store.publish(COMPANY_DATASET, [row], source, null), /company_pointer_conflict/)
  const second = await store.publish(COMPANY_DATASET, [row], source, first.revision)
  assert.deepEqual((await store.read()).companies, [row])
  // Republishing the earlier rows moves the pointer back without rewriting chunks.
  const back = await store.publish(COMPANY_DATASET, many, source, second.revision)
  assert.equal(back.replayed, true); assert.equal((await store.read()).revision, first.revision)
  await assert.rejects(store.publish(COMPANY_DATASET, [{ name: 'Bad', website: 'http://x.test' }], source, first.revision), /company_row_invalid/)
  await assert.rejects(store.publish('curated-enrichment-v1', [row], source, first.revision), /company_publication_invalid/)
  // Tampered chunk bytes are refused on read, so the runtime falls back to the static list.
  await driver.executeQuery("MATCH (c:UnlinkedCompanyChunk {dataset: $dataset, revision: $revision, ordinal: 0}) SET c.json = '[]'", { dataset: COMPANY_DATASET, revision: first.revision })
  await assert.rejects(store.read(), /company_dataset_corrupt/)
  const lookup = createCompanyFacts({ readDataset: () => store.read(), ttlMs: 0 })
  assert.equal(await lookup('Company 1'), null); assert.equal((await lookup('Riot Games')).name, 'Riot Games')
  await store.publish(COMPANY_DATASET, [row], source, first.revision)
  assert.equal((await lookup('Riot')).tagline, row.tagline)
  await store.revoke(COMPANY_DATASET, second.revision)
  assert.equal(await store.read(), null)
  assert.equal(await lookup('Riot'), null)
  assert.equal((await lookup('Riot Games')).tagline, companyFacts('Riot Games').tagline)
  await assert.rejects(store.publish(COMPANY_DATASET, [row], source, null), /company_revision_deleted/)
  await assert.rejects(store.revoke(COMPANY_DATASET, companyRevision([fresh])), /company_revision_missing/)
})
