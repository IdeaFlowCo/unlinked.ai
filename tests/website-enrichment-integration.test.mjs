// A person's own homepage on an imported profile, end to end through the REAL
// store validator (the vendored Noos module, runtime/noos): publish and read
// validate exactly as UnlinkedPublicPeopleStore does (public-people.ts publish
// and read), then the member index, the public reader and the rendered profile.
// Unlinked CI cannot fetch the private Noos repository, so this runs only when
// UNLINKED_NOOS_DIR names a built Noos checkout; the runtime rollout packet runs
// it against the staged vendored module before any restart.
// All people here are fictional.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createMemberPublicIndex, linkedinEnrichmentId, LINKEDIN_ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { prepareEnrichmentSnapshot } from '../mcp-server/publish-enrichment-people.mjs'
import { renderPerson } from '../mcp-server/private-onboarding-views.mjs'

const NOOS = process.env.UNLINKED_NOOS_DIR
const li = slug => `https://www.linkedin.com/in/${slug}`
const person = (id, name, extra = {}) => ({ id, name, positions: [], education: [], skills: [], ...extra })
const LI8 = LINKEDIN_ENRICHMENT_DATASETS.at(-1)
const MEMBER = 'member-signup-' + 'c'.repeat(64)

test('a homepage passes the real store validator and renders on the imported profile only', { skip: NOOS ? false : 'UNLINKED_NOOS_DIR is not set: Unlinked CI cannot fetch private Noos; the rollout packet runs this against the staged vendored module' }, async () => {
  const { validatePublicSnapshot } = createRequire(join(NOOS, 'package.json'))(join(NOOS, 'dist/operational/public-people.js'))
  assert.equal(typeof validatePublicSnapshot, 'function')
  // The store's publish and read, minus Neo4j: validate on the way in, keep JSON, validate again on the way out.
  const stored = new Map()
  const store = {
    publish: (dataset, snapshot) => { stored.set(dataset, JSON.stringify(validatePublicSnapshot(snapshot))) },
    read: async dataset => stored.has(dataset) ? validatePublicSnapshot(JSON.parse(stored.get(dataset))) : null,
  }
  const row = slug => ({ id: linkedinEnrichmentId(slug), name: 'Row Name', positions: [], education: [], skills: [] })
  const rows = [{ ...row('ada-fictional'), website: 'https://ada.example/' }, { ...row('cy-member'), website: 'https://cy.example/' }]
  const { snapshot } = prepareEnrichmentSnapshot(Buffer.from(JSON.stringify(rows)), LI8)
  store.publish(LI8, snapshot)
  for (const website of ['https://ada.example', 'http://ada.example/', 'https://u:p@ada.example/'])
    assert.throws(() => store.publish(LI8, { ...snapshot, profiles: [{ ...rows[0], website }] }), /public_snapshot_invalid/, website)

  const profiles = [person('public-a', 'Ada Fictional', { linkedinUrl: li('ada-fictional') }), person(MEMBER, 'Cy Member', { linkedinUrl: li('cy-member') })]
  const read = createMemberPublicIndex({ log: () => {}, readLegacy: async () => ({ state: 'published', complete: true, revision: 'legacy-public-v1:' + 'e'.repeat(64), profiles, connections: [] }),
    discover: async () => [], getBackend: async () => null, readMembers: async () => [MEMBER], linkedinEnrichmentDatasets: [...LINKEDIN_ENRICHMENT_DATASETS], includeDetails: true, publicPeople: store })
  const reader = createPublicPeopleReader({ readPublishedSnapshot: read })

  const ada = (await reader.profile({ id: 'public-a' })).profile
  assert.equal(ada.website, 'https://ada.example/')
  assert.match(renderPerson({ profile: ada }), /<a href="https:\/\/ada\.example\/" target="_blank" rel="noopener noreferrer nofollow">Website ↗<\/a>/)
  // Members' own words are never filled, so no website on a member.
  const cy = (await reader.profile({ id: MEMBER })).profile
  assert.equal(cy.website, undefined)
  assert.doesNotMatch(renderPerson({ profile: cy }), /cy\.example/)
  assert.deepEqual(read.enrichmentHealth(), { unreadable: 0, degraded: false })
})
