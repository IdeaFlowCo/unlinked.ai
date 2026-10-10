import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPublicPeopleReader, PRESENCE } from '../src/utils/public-people/reader.mjs'

test('published OpenAPI presence filters match the executable People contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../public/openapi.json', import.meta.url), 'utf8'))
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'presence-contract-1', profiles: ['member', 'legacy', 'shadow'].map(id => ({ id, name: id, positions: [], education: [], skills: [] })), connections: [], members: ['member'], legacyMembers: ['legacy'] }) })
  for (const route of ['/api/people', '/api/agent/v1/people', '/search-public']) {
    const parameter = schema.paths[route].get.parameters.find(value => value.name === 'presence')
    assert.equal(parameter.in, 'query')
    assert.equal(parameter.schema.type, 'string')
    assert.deepEqual(parameter.schema.enum, [...PRESENCE])
    for (const presence of parameter.schema.enum) {
      const result = await reader.list({ presence })
      assert.equal(result.profiles.length, 1)
      assert.equal(result.profiles[0].presence, presence)
    }
  }
})
