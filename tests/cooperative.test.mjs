// Cold-start work that used to block the event loop for seconds now runs as
// generators: the sync and async schedules must agree exactly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runAsync, runSync, ticker } from '../src/utils/cooperative.mjs'
import { buildCompanyIndex, buildCompanyIndexAsync, isValidatedCompanyRows, validateCompanyRows, validateCompanyRowsAsync } from '../mcp-server/company-metadata.mjs'
import { hashRowsJson } from '../mcp-server/company-facts-store.mjs'
import { applyProfileDecisions, applyProfileDecisionsAsync } from '../src/utils/public-people/profile-decisions.mjs'
import { linkedinIdentityMerges, linkedinIdentityMergesAsync, urlIdentityMerges, urlIdentityMergesAsync } from '../src/utils/public-people/url-identity.mjs'

function* counting(n) { const tick = ticker(64); let sum = 0; for (let i = 0; i < n; i++) { sum += i; if (tick()) yield } return sum }

test('runSync and runAsync give the same result; runAsync lets the loop run between slices', async () => {
  assert.equal(runSync(counting(100000)), await runAsync(counting(100000)))
  let turns = 0
  const other = setInterval(() => { turns++ }, 1)
  function* slow() { const end = performance.now() + 120; while (performance.now() < end) yield; return 'done' }
  assert.equal(await runAsync(slow(), { sliceMs: 5 }), 'done')
  clearInterval(other)
  assert.ok(turns >= 3, `timers ran ${turns} times during the run`)
  function* failing() { yield; throw Error('same error') }
  assert.throws(() => runSync(failing()), /same error/)
  await assert.rejects(runAsync(failing()), /same error/)
})

const companies = Array.from({ length: 3000 }, (_, i) => ({ name: `Company ${i}`, ...(i % 3 ? { aliases: [`Co ${i}`, `C-${i} Inc`] } : {}), ...(i % 5 ? { website: `https://company-${i}.example.com` } : {}), industry: 'Software', employeeCount: i }))

test('company validation and index are identical through either schedule, errors included', async () => {
  const sync = validateCompanyRows(companies), async = await validateCompanyRowsAsync(companies)
  assert.deepEqual(async, sync)
  assert.ok(isValidatedCompanyRows(sync) && isValidatedCompanyRows(async))
  assert.equal(isValidatedCompanyRows(companies), false)
  assert.deepEqual([...await buildCompanyIndexAsync(sync)], [...buildCompanyIndex(sync)])
  const duplicate = [...companies, { name: 'Company 7' }]
  assert.throws(() => validateCompanyRows(duplicate), /company_row_duplicate:3000/)
  await assert.rejects(validateCompanyRowsAsync(duplicate), /company_row_duplicate:3000/)
  const bad = [...companies.slice(0, 10), { name: 'X', website: 'http://insecure.example.com' }]
  await assert.rejects(validateCompanyRowsAsync(bad), /company_row_invalid:10:website/)
})

test('the incremental company digest equals sha256 of the whole JSON', async () => {
  const rows = validateCompanyRows(companies)
  assert.equal(await hashRowsJson(rows), createHash('sha256').update(JSON.stringify(rows)).digest('hex'))
  assert.equal(await hashRowsJson([]), createHash('sha256').update('[]').digest('hex'))
  assert.equal(await hashRowsJson(rows.slice(0, 1)), createHash('sha256').update(JSON.stringify(rows.slice(0, 1))).digest('hex'))
})

test('profile decisions and identity merges are identical through either schedule', async () => {
  const profiles = Array.from({ length: 4000 }, (_, i) => ({ id: i < 3000 ? `public-${i}` : `legacy-${i}`, name: `Person ${i}`, linkedinUrl: `https://www.linkedin.com/in/p-${i % 3500}`, positions: [], education: [], skills: [] }))
  const connections = Array.from({ length: 12000 }, (_, i) => ({ fromId: profiles[i % 4000].id, toId: profiles[(i * 7 + 1) % 4000].id })).filter(edge => edge.fromId !== edge.toId)
  const snapshot = { state: 'published', complete: true, revision: 'r', profiles, connections, members: ['legacy-3001'], legacyMembers: [] }
  const decisions = [
    { id: 'm1', kind: 'merge', profileId: 'public-1', survivorId: 'public-2' },
    { id: 'r1', kind: 'rename', profileId: 'public-3', name: 'Renamed' },
    { id: 'x1', kind: 'remove', profileId: 'public-4' },
    { id: 'u1', kind: 'unlist', profileId: 'public-5', group: 'team' },
    { id: 's1', kind: 'suspend', profileId: 'public-6' },
  ]
  assert.deepEqual(await applyProfileDecisionsAsync(snapshot, decisions), applyProfileDecisions(snapshot, decisions))
  const refFor = profile => [profile.linkedinUrl]
  const input = { profiles, members: ['legacy-3001'], absorbers: ['legacy-3001'], decisions, refFor }
  assert.deepEqual(await linkedinIdentityMergesAsync(input), linkedinIdentityMerges(input))
  const rows = profiles.slice(0, 3000).map(profile => ({ publicId: profile.id, subject: profile.linkedinUrl }))
  const slugIndex = new Map(profiles.slice(3000).map(profile => [profile.linkedinUrl.split('/in/')[1], profile.id]))
  assert.deepEqual(await urlIdentityMergesAsync({ rows, slugIndex }), urlIdentityMerges({ rows, slugIndex }))
})
