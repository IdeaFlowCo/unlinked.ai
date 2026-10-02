import test from 'node:test'
import assert from 'node:assert/strict'
import { linkedinSlug, urlIdentityMerges } from '../src/utils/public-people/url-identity.mjs'
import { applyProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'

const slugIndex = new Map([['joshua-langsam-1352407', 'langsam'], ['jacobcolemit', 'jacob'], ['sarah-25a25b219', 'sarah-new']])

test('an imported person merges into the legacy profile with the same LinkedIn address, and only then', () => {
  assert.equal(linkedinSlug('https://www.linkedin.com/in/Joshua-Langsam-1352407'), 'joshua-langsam-1352407')
  for (const value of ['https://linkedin.com/in/x', 'unlinked:added-person:abc', null, 'https://www.linkedin.com/in/a/b', 'https://www.linkedin.com/in/%E0%A4%A']) assert.equal(linkedinSlug(value), null)
  const rows = [
    { publicId: 'public-a', subject: 'https://www.linkedin.com/in/joshua-langsam-1352407' },
    { publicId: 'public-b', subject: 'https://www.linkedin.com/in/someone-else-123' },
    { publicId: 'public-c', subject: null },
    { publicId: 'public-d', subject: 'https://www.linkedin.com/in/jacobcolemit' },
    { publicId: 'public-e', subject: 'https://www.linkedin.com/in/sarah-25a25b219' },
    { publicId: 'not-public', subject: 'https://www.linkedin.com/in/jacobcolemit' },
  ]
  // public-d was already decided by an operator; sarah-new was merged into sarah-old.
  const explicit = [{ id: 'x1', kind: 'rename', profileId: 'public-d', name: 'Kept' }, { id: 'x2', kind: 'merge', profileId: 'sarah-new', survivorId: 'sarah-old' }]
  assert.deepEqual(urlIdentityMerges({ rows, slugIndex, explicit }), [
    { id: 'url:public-a', kind: 'merge', profileId: 'public-a', survivorId: 'langsam' },
    { id: 'url:public-e', kind: 'merge', profileId: 'public-e', survivorId: 'sarah-old' },
  ])
})

test('automatic merges fold the imported copy and its edge into the legacy profile', () => {
  const person = (id, name) => ({ id, name, positions: [], education: [], skills: [] })
  const snapshot = { state: 'published', complete: true, revision: 'r', profiles: [person('langsam', 'Joshua Langsam'), person('member-import-x', 'Efe'), person('public-a', 'Joshua Langsam')], connections: [{ fromId: 'member-import-x', toId: 'public-a' }], members: ['member-import-x'] }
  const after = applyProfileDecisions(snapshot, urlIdentityMerges({ rows: [{ publicId: 'public-a', subject: 'https://www.linkedin.com/in/joshua-langsam-1352407' }], slugIndex }))
  assert.deepEqual(after.profiles.map(value => value.id), ['langsam', 'member-import-x'])
  assert.deepEqual(after.connections, [{ fromId: 'member-import-x', toId: 'langsam' }]); assert.deepEqual(after.aliases, { 'public-a': 'langsam' })
})
