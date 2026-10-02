import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnrichmentSnapshot, publishEnrichmentPeople } from '../mcp-server/publish-enrichment-people.mjs'
import { ENRICHMENT_DATASET } from '../src/utils/public-people/member-projection.mjs'

const row = { id: 'ccd7f8ae-d1fe-4875-a754-bb52da449a0a', name: 'Jake Perlman-Garr', headline: 'Games Investing @ Alignment Growth', location: 'Los Angeles', company: 'Alignment Growth', positions: [{ title: 'Managing Director', company: 'Alignment Growth', startDate: 'Apr 2025' }], education: [{ institution: 'University of Pennsylvania', degree: 'BA Economics' }], skills: ['Strategy'] }
const bytes = value => Buffer.from(JSON.stringify(value))

test('prepareEnrichmentSnapshot accepts reviewed rows and derives a content-addressed revision', () => {
  const first = prepareEnrichmentSnapshot(bytes([row])), second = prepareEnrichmentSnapshot(bytes([row]))
  assert.equal(first.snapshot.revision, second.snapshot.revision)
  assert.ok(first.snapshot.revision.startsWith(ENRICHMENT_DATASET + ':'))
  assert.deepEqual(first.snapshot.connections, [])
  assert.equal(first.snapshot.profiles[0].name, 'Jake Perlman-Garr')
  assert.notEqual(first.snapshot.revision, prepareEnrichmentSnapshot(bytes([{ ...row, headline: 'Changed' }])).snapshot.revision)
})

test('prepareEnrichmentSnapshot rejects malformed rows, duplicates and unexpected fields', () => {
  for (const bad of [[], [row, row], [{ ...row, photoUrl: 'https://example.com/a.png' }], [{ ...row, name: '' }], [{ ...row, positions: [{ company: 'Missing title' }] }], [{ ...row, education: [{ degree: 'No institution' }] }], [{ ...row, skills: [''] }], { not: 'an array' }]) {
    assert.throws(() => prepareEnrichmentSnapshot(bytes(bad)))
  }
})

test('publishEnrichmentPeople refuses foreign roots and relative rows paths', async () => {
  await assert.rejects(publishEnrichmentPeople({ rowsPath: '/srv/unlinked-private-guest-pilot-20261001/enrichment/rows.json', root: '/srv/other' }), /explicit_private_enrichment_target_required/)
  await assert.rejects(publishEnrichmentPeople({ rowsPath: 'enrichment/rows.json', root: '/srv/unlinked-private-guest-pilot-20261001' }), /explicit_private_enrichment_target_required/)
  await assert.rejects(publishEnrichmentPeople({ rowsPath: '/elsewhere/rows.json', root: '/srv/unlinked-private-guest-pilot-20261001' }), /explicit_private_enrichment_target_required/)
})
