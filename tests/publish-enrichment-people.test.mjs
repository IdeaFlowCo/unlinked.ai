import test from 'node:test'
import assert from 'node:assert/strict'
import { checkStoreValidation, prepareEnrichmentSnapshot, publishEnrichmentPeople } from '../mcp-server/publish-enrichment-people.mjs'
import { ENRICHMENT_DATASET, ENRICHMENT_SHARD_DATASETS, LINKEDIN_ENRICHMENT_DATASETS } from '../src/utils/public-people/member-projection.mjs'

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

test('prepareEnrichmentSnapshot targets a named shard dataset and refuses unknown datasets', () => {
  const shard = prepareEnrichmentSnapshot(bytes([row]), ENRICHMENT_SHARD_DATASETS[0])
  assert.ok(shard.snapshot.revision.startsWith(ENRICHMENT_SHARD_DATASETS[0] + ':'))
  assert.equal(shard.snapshot.revision.split(':')[1], prepareEnrichmentSnapshot(bytes([row])).snapshot.revision.split(':')[1])
  for (const dataset of ['public-import-x', 'curated-enrichment-exa-9', 'recovered-legacy-public-v1', '']) assert.throws(() => prepareEnrichmentSnapshot(bytes([row]), dataset), /enrichment_dataset_unknown/)
})

test('a homepage travels only on LinkedIn-keyed rows, and only as a canonical credential-free HTTPS address', () => {
  const li = { id: 'li-' + 'a'.repeat(64), name: 'Ada Fictional', positions: [], education: [], skills: [] }
  const dataset = LINKEDIN_ENRICHMENT_DATASETS.at(-1)
  assert.equal(prepareEnrichmentSnapshot(bytes([{ ...li, website: 'https://ada.example/' }]), dataset).snapshot.profiles[0].website, 'https://ada.example/')
  assert.throws(() => prepareEnrichmentSnapshot(bytes([{ ...row, website: 'https://ada.example/' }])), /enrichment_rows_invalid/, 'not on id-keyed datasets')
  assert.throws(() => prepareEnrichmentSnapshot(bytes([{ ...row, website: 'https://ada.example/' }]), ENRICHMENT_SHARD_DATASETS[0]), /enrichment_rows_invalid/, 'not on id-keyed shards')
  for (const website of ['http://ada.example/', 'https://ada.example', 'https://u:p@ada.example/', 'HTTPS://ADA.example/', 'not a url', ''])
    assert.throws(() => prepareEnrichmentSnapshot(bytes([{ ...li, website }]), dataset), /enrichment_rows_invalid/, website)
})

test('the plan runs the store\'s own snapshot validator, so a plan cannot pass when execute would fail', () => {
  const li = { id: 'li-' + 'a'.repeat(64), name: 'Ada Fictional', website: 'https://ada.example/', positions: [], education: [], skills: [] }
  const { snapshot } = prepareEnrichmentSnapshot(bytes([li]), LINKEDIN_ENRICHMENT_DATASETS.at(-1))
  // An older store that does not know `website` (the 2026-11-09 failure) rejects the plan.
  const older = value => { if (value.profiles.some(profile => Object.hasOwn(profile, 'website'))) throw new Error('public_snapshot_invalid'); return value }
  assert.throws(() => checkStoreValidation(snapshot, older), /public_snapshot_invalid/)
  assert.equal(checkStoreValidation(snapshot, value => value), true)
  assert.throws(() => checkStoreValidation(snapshot, undefined), /enrichment_store_validator_missing/)
})
