import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { Module, createRequire } from 'node:module'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderOwnProfile, renderPerson } from '../mcp-server/private-onboarding-views.mjs'

const publicUrl = 'https://www.unlinked.ai/people/seed-person'
const evidence = async (name, markup) => {
  if (process.env.OPENCHAT_PROFILE_EVIDENCE) await writeFile(`${process.env.OPENCHAT_PROFILE_EVIDENCE}/${name}.html`, markup)
}
const action = markup => {
  const link = /<a\b[^>]*href="([^"]+)"[^>]*>Message with OpenChat ↗<\/a>/.exec(markup)
  const href = link?.[1]
  assert.ok(href, 'visible Message with OpenChat action')
  assert.match(link[0], /target="_blank"/)
  assert.match(link[0], /rel="noopener noreferrer"/)
  return new URL(href.replaceAll('&amp;', '&'))
}

function loadComponent(path, stubs = {}) {
  const filename = new URL(path, import.meta.url).pathname
  return readFile(filename, 'utf8').then(source => {
    const loaded = new Module(filename), require = createRequire(filename)
    loaded.require = id => Object.hasOwn(stubs, id) ? stubs[id] : require(id)
    loaded._compile(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename)
    return loaded.exports
  })
}

test('anonymous and signed-in runtime person profiles open the same context-only compose; own public context is verified', async t => {
  let handler, ownerReads = 0, writes = 0, snapshotUnavailable = false, signupSourceUnavailable = false
  const owner = { ownerId: 'synthetic-openchat-owner', userId: 'synthetic-openchat-user' }
  const snapshot = { state: 'published', complete: true, revision: 'synthetic-openchat-v1', profiles: [{ id: 'seed-person', name: 'Seed Person', presence: 'shadow', email: 'never-share@example.invalid', positions: [], education: [], skills: [] }], connections: [] }
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://id.example.invalid/authorize', transaction: { state: 'synthetic-state' } }), finish: async () => ({ issuer: 'https://id.example.invalid', subject: 'synthetic-subject', displayName: 'Seed Owner' }) },
    resolveOwner: async () => owner, signup: async () => owner,
    signupLookup: { read: async () => { if (signupSourceUnavailable) throw new Error('synthetic signup source unavailable'); return null } },
    issueAccountGrant: async () => ({ accessToken: 'synthetic-fixture' }), revokeAccountGrant: async () => {},
    ownProfileId: async () => 'seed-person',
    getBackend: async () => { ownerReads++; return { adapter: {}, readLegacyProfile: async () => ({ profileId: 'seed-person', profile: { name: 'Seed Owner' } }), listImportIds: async () => [], listImportJobIds: async () => [], readResource: async () => null, writeResource: async () => { writes++ } } },
    readPublishedSnapshot: async () => { if (snapshotUnavailable) throw new Error('synthetic unavailable index'); return snapshot },
  })
  const request = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  const anonymous = await request('/people/seed-person'); assert.equal(anonymous.status, 200)
  const anonymousMarkup = await anonymous.text()
  const anonymousAction = action(anonymousMarkup); assert.equal(anonymousAction.searchParams.get('profile'), publicUrl)
  assert.deepEqual([...anonymousAction.searchParams], [['intent', 'compose'], ['source', 'unlinked'], ['profile', publicUrl]])
  await evidence('anonymous-person', anonymousMarkup)
  assert.equal(ownerReads, 0)
  const start = await request('/login'); const transaction = start.headers.getSetCookie().find(c => c.startsWith('__Host-ul-login=')).split(';')[0]
  const finish = await request('/auth/callback/ideaflow?state=synthetic-state&code=synthetic-code', transaction)
  assert.equal(finish.status, 303)
  const session = finish.headers.getSetCookie().find(c => c.startsWith('__Host-ul-session=')).split(';')[0]
  const signedIn = await request('/people/seed-person', session); assert.equal(signedIn.status, 200)
  const signedInMarkup = await signedIn.text()
  assert.equal(action(signedInMarkup).href, anonymousAction.href)
  await evidence('signed-in-person', signedInMarkup)
  const own = await request('/profile', session); assert.equal(own.status, 200)
  const ownMarkup = await own.text()
  assert.equal(action(ownMarkup).searchParams.get('profile'), publicUrl)
  await evidence('own-published-profile', ownMarkup)
  snapshot.profiles = []
  const privateOwn = await request('/profile', session); assert.equal(privateOwn.status, 200)
  const privateMarkup = await privateOwn.text()
  assert.deepEqual([...action(privateMarkup).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
  await evidence('own-private-fallback', privateMarkup)
  snapshotUnavailable = true
  const unavailableOwn = await request('/profile', session); assert.equal(unavailableOwn.status, 200)
  assert.deepEqual([...action(await unavailableOwn.text()).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
  signupSourceUnavailable = true
  const unavailableSignup = await request('/profile', session); assert.equal(unavailableSignup.status, 200)
  const unavailableSignupMarkup = await unavailableSignup.text()
  assert.match(unavailableSignupMarkup, /Seed Owner/)
  assert.deepEqual([...action(unavailableSignupMarkup).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
  await evidence('own-unavailable-source-fallback', unavailableSignupMarkup)
  const unavailableSignupCard = await request('/card', session); assert.equal(unavailableSignupCard.status, 200)
  assert.match(await unavailableSignupCard.text(), /Seed Owner/)
  snapshotUnavailable = false
  snapshot.profiles = [{ id: 'seed-person', name: 'Seed Person', positions: [], education: [], skills: [] }]
  const restoredPublicProfile = await request('/profile', session)
  assert.equal(restoredPublicProfile.status, 200)
  const restoredMarkup = await restoredPublicProfile.text()
  assert.match(restoredMarkup, /Seed Owner/)
  assert.equal(action(restoredMarkup).searchParams.get('profile'), publicUrl)
  await evidence('own-unavailable-source-published', restoredMarkup)
  const restoredCard = await request('/card', session)
  assert.equal(restoredCard.status, 200)
  const restoredCardMarkup = await restoredCard.text()
  assert.match(restoredCardMarkup, /Seed Owner/)
  assert.ok(restoredCardMarkup.includes('/people/seed-person'))
  assert.ok(restoredCardMarkup.includes('<svg'))
  await evidence('card-unavailable-source-published', restoredCardMarkup)
  assert.equal(writes, 0, 'viewing/opening compose creates no message, conversation or cross-account link')
})

test('private-only own profile never exports its name, imported email, account id or private profile id', () => {
  const page = renderOwnProfile({ csrf: 'c', profile: { id: 'private-person-id', name: 'Private Person', email: 'private@example.invalid' } })
  assert.deepEqual([...action(page.content).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
  assert.match(page.content, /Your private profile details stay here/)
})

test('rendered public action escapes RFC3986 profile ids and never exports profile fields', () => {
  const page = renderPerson({ profile: { id: "é!'()*<seed>", name: '<script>private-name</script>', email: 'private@example.invalid', user_id: 'not-a-recipient', positions: [], education: [], skills: [] } })
  assert.equal(action(page.content).searchParams.get('profile'), 'https://www.unlinked.ai/people/%C3%A9%21%27%28%29%2A%3Cseed%3E')
  assert.deepEqual([...action(page.content).searchParams.keys()], ['intent', 'source', 'profile'])
  assert.ok(!page.content.includes('<script>private-name</script>'))
})

test('Next public person body executes the same public context action', async () => {
  const component = await loadComponent('../src/components/public-directory/People.tsx', { './Directory.module.css': new Proxy({}, { get: (_, key) => String(key) }) })
  const markup = renderToStaticMarkup(React.createElement(component.ProfileBody, { profile: { id: 'seed-person', name: 'Seed Person', positions: [], education: [], skills: [], connections: [] } }))
  assert.equal(action(markup).searchParams.get('profile'), publicUrl)
})

test('historical private profile body offers compose without publishing its row or treating its user_id as a recipient', async () => {
  const component = await loadComponent('../src/app/profiles/[id]/ProfileDetails.tsx', {
    '@/utils/supabase/client': { createClient: () => ({ auth: {} }) },
    'next/navigation': { useRouter: () => ({ refresh() {} }) },
    './EditProfileForm': { __esModule: true, default: () => null },
  })
  const markup = renderToStaticMarkup(React.createElement(component.default, { profile: { id: 'private-row', user_id: 'not-an-openchat-recipient', full_name: 'Private Name', positions: [], education: [], skills: [] } }))
  assert.deepEqual([...action(markup).searchParams], [['intent', 'compose'], ['source', 'unlinked']])
})
