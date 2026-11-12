import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROFESSIONAL_PEOPLE_DATASET, prepareProfessionalSnapshot, professionalProfileId } from '../src/utils/public-people/professional-profiles.mjs'
import { publishProfessionalSnapshot } from '../mcp-server/publish-professional-people.mjs'
import { withProfessionalProfileDetails } from '../mcp-server/professional-people-manifest.mjs'
import { createMemberPublicIndex } from '../src/utils/public-people/member-projection.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createMemoryProfileHandleStore, createProfileHandles } from '../mcp-server/profile-handles.mjs'
import { setProfileHandleLookup } from '../src/utils/public-people/profile-handles.mjs'

const person = (slug, name) => ({ id: professionalProfileId(`https://www.linkedin.com/in/${slug}`), name, linkedinUrl: `https://www.linkedin.com/in/${slug}`, website: `https://${slug}.example/`, headline: 'Research Engineer', company: 'Fictional Research', location: 'Boston', about: 'Public professional biography from an independently reviewed source.', positions: [{ title: 'Research Engineer', company: 'Fictional Research' }], education: [], skills: ['Research'] })
const prepare = rows => prepareProfessionalSnapshot(Buffer.from(JSON.stringify(rows)))

test('Noos-compatible publication reaches anonymous canonical pages and APIs; append, member precedence and revoke stay visible through HTTP', async t => {
  const ada = person('ada-fictional', 'Ada Fictional'), ben = person('ben-fictional', 'Ben Fictional'), memberCopy = person('cy-fictional', 'Cy Source')
  const member = { ...memberCopy, id: 'legacy-member', name: 'Cy Member', about: 'Member-authored biography' }
  const root = await mkdtemp(join(process.cwd(), '.professional-http-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'audit'), { mode: 0o700 })
  let stored = null, privateReads = 0
  const validatePublicSnapshot = snapshot => {
    const allowed = new Set(['id','name','headline','location','about','company','positions','education','skills'])
    if (snapshot.profiles.some(row => Object.keys(row).some(key => !allowed.has(key)))) throw Error('public_snapshot_invalid')
  }
  const store = {
    read: async dataset => dataset === PROFESSIONAL_PEOPLE_DATASET && stored ? JSON.parse(stored) : null,
    publish: async (dataset, snapshot, source, expected) => {
      validatePublicSnapshot(snapshot)
      assert.equal(JSON.parse(stored ?? 'null')?.revision ?? null, expected)
      stored = JSON.stringify(snapshot)
    },
  }
  const publish = incoming => publishProfessionalSnapshot({ root, store, validatePublicSnapshot, incoming,
    receipt: { dataset: PROFESSIONAL_PEOPLE_DATASET, sourceSha256: 'a'.repeat(64) }, expectedRevision: JSON.parse(stored ?? 'null')?.revision ?? 'none' })
  await publish(prepare([ada, memberCopy]))
  const read = createMemberPublicIndex({
    readLegacy: async () => ({ state: 'published', complete: true, revision: 'legacy:http', profiles: [member], connections: [] }),
    discover: async () => [], getBackend: async () => { privateReads++; throw Error('unexpected private access') },
    readMembers: async () => [member.id], readLegacyMembers: async () => [member.id],
    professionalProfiles: true, mergeSameLinkedin: true,
    publicPeople: withProfessionalProfileDetails(store, root),
  })
  const handles = createProfileHandles({ store: createMemoryProfileHandleStore() })
  await handles.initialize()
  for (const row of [ada, ben, member]) await handles.ensure(row)
  setProfileHandleLookup(id => handles.handleFor(id))
  t.after(() => setProfileHandleLookup(null))
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'synthetic',
    login: { begin: async () => { throw Error('anonymous request must not log in') }, finish: async () => {} },
    resolveOwner: async () => null, getBackend: async () => { privateReads++; throw Error('unexpected private access') },
    readPublishedSnapshot: read, profileHandles: handles, lookupCompanyFacts: async () => null,
  })
  const observations = []
  const request = async path => { const response = await fetch(endpoint + path, { redirect: 'manual' }); observations.push({ path, status: response.status, location: response.headers.get('location') }); return response }
  const evidence = async (name, content) => { if (process.env.UNLINKED_PROFILE_TEST_EVIDENCE) await writeFile(join(process.env.UNLINKED_PROFILE_TEST_EVIDENCE, name), content) }
  const redirect = await request(`/people/${ada.id}`)
  assert.equal(redirect.status, 301); assert.equal(redirect.headers.get('location'), '/people/ada-fictional')
  const page = await request('/people/ada-fictional'); assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<title>Ada Fictional/); assert.match(html, /Public professional biography/)
  assert.ok(html.includes(`href="${ada.website}"`))
  assert.doesNotMatch(html, /Field X|PRIVATE_EMAIL|PRIVATE_PHONE|Member-authored biography/)
  await evidence('publication-ada-anonymous.html', html)
  const response = await request('/api/people/ada-fictional'); assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.profile.id, ada.id); assert.equal(data.profile.presence, 'shadow')
  assert.equal(data.profile.about, ada.about); assert.deepEqual(data.profile.connections, [])
  assert.equal(data.profile.linkedinUrl, ada.linkedinUrl)
  assert.equal(data.profile.website, ada.website)
  await evidence('publication-ada-api.json', JSON.stringify(data, null, 2))
  const memberResponse = await request('/api/people/cy-fictional'); assert.equal(memberResponse.status, 200)
  const memberData = await memberResponse.json()
  assert.equal(memberData.profile.id, member.id); assert.equal(memberData.profile.presence, 'member')
  assert.equal(memberData.profile.about, member.about)
  await publish(prepare([ben]))
  assert.equal((await request('/people/ada-fictional')).status, 200)
  const benPage = await request('/people/ben-fictional'); assert.equal(benPage.status, 200)
  await evidence('publication-ben-anonymous.html', await benPage.text())
  const directory = await request('/api/people'); assert.equal(directory.status, 200)
  assert.deepEqual((await directory.json()).profiles.map(row => row.id).sort(), [ada.id, ben.id, member.id].sort())
  stored = null
  assert.equal((await request('/people/ada-fictional')).status, 404)
  assert.equal((await request('/api/people/ben-fictional')).status, 404)
  assert.equal((await request('/api/people/cy-fictional')).status, 200)
  const revoked = await request('/api/people'); assert.equal(revoked.status, 200)
  assert.deepEqual((await revoked.json()).profiles.map(row => row.id), [member.id])
  assert.equal(privateReads, 0)
  await evidence('publication-http-lifecycle.json', JSON.stringify({ fixture: 'Fictional people; injected Noos-whitelist store, durable manifest/publisher, real hydration, projection and HTTP handler', observations, privateReads }, null, 2))
})
