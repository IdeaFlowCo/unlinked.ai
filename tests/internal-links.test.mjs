import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'
import { companyPageName } from '../src/utils/public-people/text-match.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPerson } from '../mcp-server/private-onboarding-views.mjs'

// Shaped like /people/aakarshgpt on 2026-10-24: the import named the company
// "Lopus AI (YC W25)" while the experience (Exa enrichment) says "Lopus (YC W25)".
const imported = { id: 'imported', name: 'Aakarsh Example', headline: 'Founding Engineer', company: 'Lopus AI (YC W25)', linkedinUrl: 'https://www.linkedin.com/in/aakarsh-example', positions: [{ title: 'Data Engineer', company: 'Lopus (YC W25)' }, { title: 'App Developer', company: 'Mercle' }, { title: 'Volunteer', company: '—' }], education: [{ institution: 'Example Institute' }], skills: [] }
const snapshot = { state: 'published', complete: true, revision: 'public-v1', profiles: [
  imported,
  { id: 'peer', name: 'Peer Example', headline: 'Engineer', company: 'Mercle', positions: [], education: [], skills: [] },
], connections: [{ fromId: 'peer', toId: 'imported' }] }

test('a profile company with no matching position still has a company page', async () => {
  const reader = createPublicPeopleReader({ readPublishedSnapshot: async () => snapshot })
  assert.deepEqual((await reader.company({ name: 'Lopus AI (YC W25)' })).people.map(person => person.id), ['imported'])
  assert.deepEqual((await reader.company({ name: 'Lopus (YC W25)' })).people.map(person => person.id), ['imported'])
  assert.deepEqual((await reader.company({ name: 'Mercle' })).people.map(person => person.id).sort(), ['imported', 'peer'])
})

test('a company name the page cannot look up renders as text, never as a link', () => {
  for (const name of ['—', '...', 'a '.repeat(13), 'x'.repeat(201)]) assert.equal(companyPageName(name), false, name)
  for (const name of ['Lopus AI (YC W25)', 'C++', 'X']) assert.equal(companyPageName(name), true, name)
  const page = renderPerson({ profile: { ...imported, company: '—' } }).content
  assert.doesNotMatch(page, /href="\/companies\/%E2%80%94"/)
  assert.match(page, /href="\/companies\/Lopus%20(?:\(|%28)YC%20W25(?:\)|%29)"/)
})

test('every internal link on profile and company pages resolves (no 404 or 400)', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a' }) }, resolveOwner: async () => ({ ownerId: 'owner-a', userId: 'user-a' }), getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot })
  const seen = new Map(), bodies = new Map()
  const visit = async path => {
    if (seen.has(path)) return bodies.get(path)
    let response = await fetch(endpoint + path, { redirect: 'manual' })
    for (let hop = 0; hop < 4 && response.status >= 300 && response.status < 400; hop++) {
      const next = new URL(response.headers.get('location'), endpoint + path)
      if (next.origin !== endpoint || /^\/login\b/.test(next.pathname)) break
      response = await fetch(next, { redirect: 'manual' })
    }
    // A members-only page answers visitors with its sign-in page (401 HTML): not a dead end.
    seen.set(path, response.status)
    bodies.set(path, response.status === 200 && (response.headers.get('content-type') ?? '').includes('text/html') ? await response.text() : null)
    return bodies.get(path)
  }
  const linksOf = body => [...body.matchAll(/<a\b[^>]*?\shref="([^"#][^"]*)"/g)].map(match => match[1].replace(/&amp;/g, '&')).filter(href => href.startsWith('/') && !href.startsWith('//') && !/^\/(?:login|logout|auth|oauth|mcp)\b/.test(href) && !href.endsWith('/photo'))
  const pages = ['/people/imported', '/people/peer']
  for (const page of pages) {
    const body = await visit(page)
    assert.ok(body, `${page} renders`)
    for (const href of linksOf(body)) {
      const linked = await visit(href)
      if (linked && href.startsWith('/companies/')) for (const inner of linksOf(linked)) await visit(inner)
    }
  }
  assert.ok([...seen.keys()].some(path => path === '/companies/Lopus%20AI%20(YC%20W25)'), 'the header company is linked')
  const broken = [...seen].filter(([, status]) => status !== 200 && status !== 401)
  assert.deepEqual(broken, [])
})

test('pages opt out of Cloudflare email obfuscation, whose decoder the page CSP blocks', async t => {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin: async () => ({ location: 'https://idp.invalid/login', transaction: { state: 'state' } }), finish: async () => ({ issuer: 'https://idp.invalid', subject: 'subject-a' }) }, resolveOwner: async () => ({ ownerId: 'owner-a', userId: 'user-a' }), getBackend: async () => ({}), readPublishedSnapshot: async () => snapshot })
  for (const path of ['/', '/support', '/people/imported']) {
    const body = await (await fetch(endpoint + path)).text()
    assert.match(body, /^<!doctype html><html lang="en"><!--email_off-->/, path)
    assert.match(body, /<!--\/email_off--><\/html>$/, path)
  }
})
