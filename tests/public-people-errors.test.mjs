import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPeopleError } from '../mcp-server/private-onboarding-views.mjs'

const snapshot = { state: 'published', complete: true, revision: 'error-pages-v1', profiles: [], connections: [] }
async function runtime(t, readPublishedSnapshot = async () => snapshot) {
  let handler
  const server = createServer((request, response) => void handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: origin.replace('http:', 'https:'), readPublishedSnapshot,
    login: { begin: async () => { throw Error('unexpected login') }, finish: async () => { throw Error('unexpected callback') } },
    resolveOwner: async () => { throw Error('unexpected owner lookup') }, getBackend: async () => { throw Error('unexpected private read') },
  })
  return (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options })
}

test('missing, invalid and unavailable public pages explain recovery without leaking backend errors', async t => {
  const request = await runtime(t)
  for (const [path, title] of [['/people/missing', 'Profile not found'], ['/people/missing/connections', 'Profile not found'], ['/companies/Unknown', 'Company page not found']]) {
    const response = await request(path)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const page = await response.text()
    assert.ok(page.includes(title))
    assert.match(page, /href="\/people">Search People/)
    assert.match(page, /href="\/support"/)
    const head = await request(path, { method: 'HEAD' })
    assert.equal(head.status, 404)
    assert.equal(await head.text(), '')
  }
  const invalid = await request('/people?q=a&q=b')
  assert.equal(invalid.status, 400)
  assert.match(await invalid.text(), /link or its filters could not be read/)
  const api = await request('/api/people?q=a&q=b')
  assert.equal(api.status, 400)
  assert.deepEqual(await api.json(), { error: 'public_people_input_invalid' })

  const down = await runtime(t, async () => { throw Error('private database details must stay private') })
  for (const path of ['/people/missing', '/companies/Unknown']) {
    const response = await down(path)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '10')
    const page = await response.text()
    assert.match(page, /People are unavailable right now/)
    assert.match(page, /Try again/)
    assert.doesNotMatch(page, /private database details/)
  }
  assert.deepEqual(await (await down('/api/people')).json(), { error: 'public_people_unavailable' })
})

test('exhausted minute budget returns useful browser and API errors with an honest retry interval', async t => {
  const request = await runtime(t)
  for (let i = 0; i < 120; i++) {
    const response = await request('/api/people')
    assert.equal(response.status, 200)
    await response.text()
  }
  const response = await request('/people/missing?show=members')
  assert.equal(response.status, 429)
  const seconds = Number(response.headers.get('retry-after'))
  assert.ok(seconds > 10 && seconds <= 60)
  const page = await response.text()
  assert.match(page, /Unlinked is busy right now/)
  assert.ok(page.includes(`wait ${seconds} seconds`))
  assert.match(page, /href="\/people\/missing\?show=members">Try again/)
  assert.match(response.headers.get('cache-control'), /no-cache|no-store/)
  const api = await request('/api/people')
  assert.equal(api.status, 429)
  assert.deepEqual(await api.json(), { error: 'public_people_rate_limited' })
  const head = await request('/people/missing', { method: 'HEAD' })
  assert.equal(head.status, 429)
  assert.match(head.headers.get('content-type'), /text\/html/)
  assert.equal(await head.text(), '')
})

test('retry links stay same-origin and escape URL text', () => {
  for (const retry of ['//evil.invalid', '/\\evil.invalid', '/\nevil.invalid', 'https://evil.invalid']) {
    assert.match(renderPeopleError({ status: 429, retry }).content, /href="">Try again/)
  }
  const page = renderPeopleError({ status: 429, retry: '/people/a?q="<test>&show=members' }).content
  assert.match(page, /href="\/people\/a\?q=&quot;&lt;test&gt;&amp;show=members"/)
})
