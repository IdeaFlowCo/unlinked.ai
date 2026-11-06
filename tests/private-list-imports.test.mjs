// Upload a list of people (such as LinkedIn followers) in the browser
// (unlinked-h2e4), on top of the private list import from PR #238.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fixture } from './helpers/investor-fixture.mjs'
import { createAccountToolService } from '../mcp-server/account-tools.mjs'
import { composeAccountScope } from '../mcp-server/account-grants.mjs'
import { createPrivateListImports, detectListMapping, LIST_TOOLS, LIST_ERRORS } from '../mcp-server/private-list-imports.mjs'
import { renderBringArchive, renderListImport } from '../mcp-server/private-onboarding-views.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'

const followers = 'Name,Profile URL,Headline,Company\nAda Lovelace,https://www.linkedin.com/in/ada-follower,Analyst,Engines\nGrace Hopper,,Admiral,Navy\nAlan Turing,https://www.linkedin.com/in/alan-follower,,NPL\n'

test('common follower CSV shapes map automatically; a file without a name column says what to add', () => {
  assert.deepEqual(detectListMapping(followers).mapping, { name: 'Name', linkedinUrl: 'Profile URL', title: 'Headline', company: 'Company' })
  assert.deepEqual(detectListMapping('First Name,Last Name,LinkedIn URL,Job Title\nA,B,,C\n').mapping, { firstName: 'First Name', lastName: 'Last Name', linkedinUrl: 'LinkedIn URL', title: 'Job Title' })
  assert.deepEqual(detectListMapping('﻿full_name,public profile url,e-mail\nA,,\n').mapping, { name: 'full_name', linkedinUrl: 'public profile url', email: 'e-mail' })
  // A full name wins over split names.
  assert.deepEqual(Object.keys(detectListMapping('Name,First Name,Last Name\nA,B,C\n').mapping), ['name'])
  assert.equal(detectListMapping('Profile URL,Company\nx,y\n').error, 'list_name_column_missing')
  assert.match(LIST_ERRORS.list_name_column_missing, /“Name”/)
})

test('an uploaded follower list becomes an owner-private list through the shared tool service, written as the owner, never connections', async () => {
  const f = fixture(), service = createAccountToolService(f.options)
  const owner = { ownerId: 'alice', userId: 'alice-user' }
  const appGrant = who => ({ ownerId: who.ownerId, userId: who.userId, scope: composeAccountScope({ privateNotes: true }), tools: [...LIST_TOOLS], agent: 'Unlinked import page', app: true })
  // Staging goes through the real tool service (the in-process owner grant's
  // scope is accepted); batches run through the same tools with the fixture's
  // contact lookup, as #238's own workflow tests do.
  const tools = f.tools()
  const lists = createPrivateListImports({ pauseMs: 1, sleep: async () => {},
    call: async (who, name, input) => name === 'unlinked_stage_investor_csv' ? (await service.call({ grant: appGrant(who), name, input })).result : tools[name](appGrant(who), input) })
  const staged = await lists.stage(owner, { csv: followers, listName: 'LinkedIn followers' })
  for (let i = 0; i < 50 && lists.running(owner, staged.importId); i++) await new Promise(resolve => setTimeout(resolve, 5))
  const status = await lists.status(owner, staged.importId)
  assert.equal(status.status, 'complete'); assert.equal(status.imported, 3); assert.equal(status.visibility, 'owner_private')
  const graph = f.state('alice')
  const list = [...graph.entities.values()].find(entity => entity.kind === 'list')
  assert.equal(list.name, 'LinkedIn followers')
  assert.equal([...graph.links.values()].filter(link => link.fromId === list.id && link.relation === 'contains').length, 3)
  assert.ok([...graph.links.values()].every(link => link.relation === 'contains'), 'membership only, never knows/connections')
  const provenance = [...graph.notes.values()].map(note => note.provenance)
  assert.ok(provenance.length && provenance.every(value => value.author === 'owner' && value.source === 'app'), 'written as the owner in the app')
  // The view names rows through the import's mapping.
  const page = renderListImport({ csrf: 'x', list: status }).content
  assert.match(page, /Your list “LinkedIn followers” is ready/)
  assert.match(page, /Ada Lovelace<\/b> · Analyst · Engines/)
  assert.match(page, /not your connections and were not notified/)
})

test('the import page offers list upload under its own closed disclosure, and the routes stage, show and continue', async t => {
  const form = renderBringArchive({ csrf: 'x', listUploads: true }).content
  assert.match(form, /<details class="advanced" id="list-upload"><summary>Upload a list of people, such as your LinkedIn followers<\/summary>/)
  assert.match(form, /never added as connections, never shown publicly, and nobody is notified/)
  assert.doesNotMatch(renderBringArchive({ csrf: 'x' }).content, /list-upload/)

  const id = 'f'.repeat(64), calls = []
  const privateListImports = {
    stage: async (owner, input) => { calls.push(['stage', owner.ownerId, input.listName]); if (!input.csv.startsWith('Name')) throw Object.assign(Error('list_name_column_missing'), { code: 'list_name_column_missing' }); return { importId: id } },
    status: async (owner, importId, offset) => { calls.push(['status', importId, offset]); return { importId, status: 'running', listName: 'LinkedIn followers', total: 3, processed: 1, imported: 1, rejected: 0, mapping: { name: 'Name' }, receipts: [{ fields: { Name: 'Ada <b>' }, result: { status: 'imported' } }], nextOffset: null } },
    resume: (owner, importId) => calls.push(['resume', importId]), running: () => false,
  }
  const owner = { ownerId: 'list-owner', userId: 'list-user' }
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  handler = createPrivateBrowserHandler({ privateListImports, baseUrl, dataMode: 'private_live', backgroundImports: true, login: {
    begin: async () => ({ location: 'https://test.invalid/login', transaction: { state: 'state' } }),
    finish: async () => ({ issuer: 'https://test.invalid', subject: 'list-subject', verifiedEmail: 'robin@example.invalid', displayName: 'Robin Fictional' }),
  }, resolveOwner: async () => owner, signup: async () => owner, issueAccountGrant: async () => ({ accessToken: 'g' }), revokeAccountGrant: async () => {}, getBackend: async () => backend })
  const go = (path, options = {}) => fetch(endpoint + path, { redirect: 'manual', ...options })
  const start = await go('/login'), loginCookie = start.headers.getSetCookie()[0].split(';')[0]
  const cookie = (await go('/auth/callback/ideaflow?code=c&state=state', { headers: { Cookie: loginCookie } })).headers.getSetCookie().find(value => value.startsWith('__Host-ul-session=')).split(';')[0]
  const page = await (await go('/import', { headers: { Cookie: cookie } })).text()
  assert.match(page, /id="list-upload"/)
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1]
  const upload = async (text, name = 'followers.csv') => {
    const body = new FormData(); body.set('csrf', csrf); body.set('listName', 'LinkedIn followers'); body.set('listFile', new Blob([text]), name)
    return go('/import/list', { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl }, body })
  }
  const ok = await upload(followers)
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), `/import/list/${id}`)
  const bad = await upload('Profile URL\nx\n')
  assert.equal(bad.status, 400); assert.match(await bad.text(), /couldn’t find a name column/)
  assert.equal((await upload(followers, 'followers.xlsx')).status, 400)
  const status = await (await go(`/import/list/${id}?offset=0`, { headers: { Cookie: cookie } })).text()
  assert.match(status, /Importing “LinkedIn followers”…/); assert.match(status, /Ada &lt;b&gt;/); assert.match(status, /Continue importing/)
  const resumed = await go(`/import/list/${id}/continue`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) })
  assert.equal(resumed.status, 303)
  assert.deepEqual(calls.map(call => call[0]), ['stage', 'stage', 'status', 'status', 'resume'])
  // Continue on an import this owner does not have is a 404, not a runner.
  privateListImports.status = async () => { throw Object.assign(Error('nope'), { code: 'not_found' }) }
  const unknown = await go(`/import/list/${'e'.repeat(64)}/continue`, { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) })
  assert.equal(unknown.status, 404)
  assert.equal(calls.filter(call => call[0] === 'resume').length, 1)
  assert.equal(calls[0][1], 'list-owner', 'staged for the signed-in owner only')
})

test('a persistent outage stops the background runner after a few tries instead of spending the owner’s tool budget', async () => {
  let calls = 0
  const lists = createPrivateListImports({ pauseMs: 1, sleep: async () => {},
    call: async (who, name) => { if (name === 'unlinked_stage_investor_csv') return { importId: 'i'.repeat(64) }; calls++; throw Object.assign(Error('down'), { code: 'upstream_unavailable' }) } })
  await lists.stage({ ownerId: 'o', userId: 'u' }, { csv: followers, listName: 'L' })
  for (let i = 0; i < 50 && lists.running({ ownerId: 'o', userId: 'u' }, 'i'.repeat(64)); i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(calls, 5)
})

test('one owner’s imports run one at a time, and a batch that stops making progress ends the runner', async () => {
  let active = 0, peak = 0
  const progress = new Map()
  const lists = createPrivateListImports({ pauseMs: 1, sleep: async () => {},
    call: async (who, name, input) => {
      if (name === 'unlinked_stage_investor_csv') return { importId: input.listName.padEnd(64, '0') }
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--
      const done = (progress.get(input.importId) ?? 0) + 1; progress.set(input.importId, done)
      return { status: done >= 3 ? 'complete' : 'running', processed: done }
    } })
  const owner = { ownerId: 'serial', userId: 'u' }
  const a = await lists.stage(owner, { csv: followers, listName: 'a' }), b = await lists.stage(owner, { csv: followers, listName: 'b' })
  for (let i = 0; i < 200 && (lists.running(owner, a.importId) || lists.running(owner, b.importId)); i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(peak, 1, 'never two batches for the same owner at once')
  assert.equal(progress.get(a.importId), 3); assert.equal(progress.get(b.importId), 3)
  // Stalled: the same `processed` three times in a row stops the runner.
  let resumes = 0
  const stuck = createPrivateListImports({ pauseMs: 1, sleep: async () => {},
    call: async (who, name) => { if (name === 'unlinked_stage_investor_csv') return { importId: 's'.repeat(64) }; resumes++; return { status: 'running', processed: 7 } } })
  await stuck.stage(owner, { csv: followers, listName: 'L' })
  for (let i = 0; i < 50 && stuck.running(owner, 's'.repeat(64)); i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(resumes, 4)
})

