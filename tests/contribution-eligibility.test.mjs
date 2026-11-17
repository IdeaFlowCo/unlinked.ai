import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateContribution, contributionDecision, identityHash, AUTO_AWARD } from '../mcp-server/contribution-eligibility.mjs'

const owner = { ownerId: 'owner', userId: 'user' }, sha = 'a'.repeat(64)
const rows = (count, { offset = 0, day = i => `2026-0${1 + i % 9}-${String(1 + i % 27).padStart(2, '0')}` } = {}) => Array.from({ length: count }, (_, i) => ({ linkedinUrl: `https://www.linkedin.com/in/person-${offset + i}`, connectedOn: day(i) }))

test('a useful new archive yields an eligible receipt and a proposal for review, never an award', () => {
  const receipt = evaluateContribution({ owner, archiveSha256: sha, rows: rows(200), now: () => 1 })
  assert.equal(AUTO_AWARD, false); assert.equal(receipt.eligible, true); assert.equal(receipt.awarded, false); assert.equal(receipt.autoAward, false)
  assert.deepEqual(receipt.proposal, { from: 'standard', to: 'approved', requires: 'operator_review' })
  assert.equal(receipt.counts.newIdentities, 200); assert.equal(receipt.creditableIdentityHashes.length, 200)
  assert.ok(!JSON.stringify(receipt).includes('person-1'), 'a receipt carries hashes, never who is in the archive')
  assert.match(receipt.limits, /does not prove the archive is authentic/)
  assert.throws(() => { receipt.eligible = false }, TypeError)
})

test('the same archive, already-credited people and people already shared earn nothing again', () => {
  const first = evaluateContribution({ owner, archiveSha256: sha, rows: rows(200) })
  const replay = evaluateContribution({ owner, archiveSha256: sha, rows: rows(200), creditedArchives: new Set([sha]), credited: new Set(first.creditableIdentityHashes) })
  assert.equal(replay.eligible, false); assert.equal(replay.counts.newIdentities, 0); assert.equal(replay.checks.find(entry => entry.id === 'not_replayed').ok, false)
  const renamed = evaluateContribution({ owner, archiveSha256: 'b'.repeat(64), rows: [...rows(200), ...rows(10, { offset: 500 })], credited: new Set(first.creditableIdentityHashes) })
  assert.equal(renamed.eligible, false, 'a re-zipped copy with a few additions is not a new contribution'); assert.equal(renamed.counts.alreadyCredited, 200); assert.equal(renamed.counts.newIdentities, 10)
  const known = evaluateContribution({ owner, archiveSha256: 'c'.repeat(64), rows: rows(200), knownShared: new Set(rows(180).map(row => identityHash(row.linkedinUrl.split('/in/')[1]))) })
  assert.equal(known.eligible, false); assert.equal(known.counts.alreadyShared, 180); assert.equal(known.counts.newIdentities, 20)
})

test('raw size, padding and generated-looking files are not contributions', () => {
  const failed = (input, id) => { const receipt = evaluateContribution({ owner, archiveSha256: sha, ...input }); assert.equal(receipt.eligible, false, id); assert.equal(receipt.checks.find(entry => entry.id === id).ok, false, id); assert.deepEqual(receipt.creditableIdentityHashes, []); assert.equal(receipt.proposal.requires, 'none') }
  failed({ rows: [] }, 'format')
  failed({ rows: rows(30001) }, 'format')
  failed({ rows: [...rows(100), ...Array.from({ length: 400 }, (_, i) => ({ name: 'Name Only ' + i }))] }, 'exact_addresses')
  failed({ rows: [...rows(100), ...rows(100)] }, 'duplicates')
  failed({ rows: rows(200, { day: () => '2026-11-01' }) }, 'date_spread')
  failed({ rows: rows(20) }, 'new_contribution')
  failed({ rows: Array.from({ length: 200 }, (_, i) => ({ linkedinUrl: 'https://example.com/in/person-' + i })) }, 'exact_addresses')
})

test('existing manual access is preserved and only a named reviewer can produce a grant instruction, which performs no write', () => {
  for (const currentTier of ['verified', 'approved']) assert.deepEqual(evaluateContribution({ owner, archiveSha256: sha, rows: rows(200), currentTier }).proposal, { from: currentTier, to: currentTier, requires: 'none' })
  const receipt = evaluateContribution({ owner, archiveSha256: sha, rows: rows(200) })
  const granted = contributionDecision(receipt, { reviewer: 'jacob', approve: true })
  assert.equal(granted.decision, 'grant_approved_tier'); assert.equal(granted.performed, false)
  assert.equal(contributionDecision(receipt, { reviewer: 'jacob', approve: false }).decision, 'no_change')
  assert.equal(contributionDecision(evaluateContribution({ owner, archiveSha256: sha, rows: rows(10) }), { reviewer: 'jacob', approve: true }).decision, 'no_change', 'an ineligible receipt cannot be approved into a grant')
  assert.throws(() => contributionDecision(receipt, { approve: true }), /reviewer_required/)
  assert.throws(() => contributionDecision({ ...receipt, version: 2 }, { reviewer: 'jacob', approve: true }), /receipt_invalid/)
  assert.throws(() => evaluateContribution({ owner: {}, archiveSha256: sha, rows: [] })); assert.throws(() => evaluateContribution({ owner, archiveSha256: 'short', rows: [] }))
})
