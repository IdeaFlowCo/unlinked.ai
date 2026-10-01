import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectory } from '../src/components/public-directory/contract.ts'

test('public reader distinguishes unavailable, empty and unknown profiles', async () => {
  assert.equal((await createDirectory().list('')).state, 'unavailable')
  const directory = createDirectory({ list: async () => ({ profiles: [] }), profile: async () => null })
  assert.deepEqual(await directory.list(''), { state: 'ready', data: { profiles: [] } })
  assert.deepEqual(await directory.profile('missing'), { state: 'not-found' })
  const failed = createDirectory({ list: async () => { throw Error('offline') }, profile: async () => { throw Error('offline') } })
  assert.equal((await failed.list('')).state, 'unavailable')
  assert.equal((await failed.profile('x')).state, 'unavailable')
})
test('reader passes bounded queries/cursors and keeps only public DTO fields', async () => {
  const inputs = [], person = { id: 'synthetic-person', name: 'Synthetic Person', headline: 'Engineer', email: 'unpublished@example.invalid', ownerId: 'private-owner' }
  const directory = createDirectory({ list: async input => { inputs.push(input); return { profiles: [person], nextCursor: 'page-2', internal: 'not-public' } }, profile: async input => { inputs.push(input); return { profile: { ...person, positions: [], education: [], skills: [], connections: [] } } } })
  const list = await directory.list('q'.repeat(300), 'cursor')
  assert.equal(inputs[0].query.length, 200)
  assert.equal(inputs[0].cursor, 'cursor')
  assert.equal(list.data.nextCursor, 'page-2')
  assert.equal(list.data.profiles[0].ownerId, undefined)
  assert.equal(list.data.profiles[0].email, undefined)
  const detail = await directory.profile(person.id, 'connections-page-2')
  assert.equal(detail.state, 'ready')
  assert.equal(inputs[1].cursor, 'connections-page-2')
  assert.equal(detail.data.email, undefined)
})
test('malformed and excessive public output fails unavailable rather than manufacturing results', async () => {
  for (const value of [{ profiles: [{ id: 'x' }] }, { profiles: Array.from({ length: 101 }, () => ({ id: 'x', name: 'Person' })) }]) {
    const directory = createDirectory({ list: async () => value, profile: async () => ({ profile: { id: 'x', name: 'Person' } }) })
    assert.equal((await directory.list('')).state, 'unavailable')
    assert.equal((await directory.profile('x')).state, 'unavailable')
  }
})
