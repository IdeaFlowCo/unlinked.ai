import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import { createRestartNotice, RESTART_NOTICE_SCRIPT } from '../mcp-server/restart-notice.mjs'

test('stream announces before shutdown, includes late arrivals, closes and guards methods/origin/capacity', async t => {
  const notices = createRestartNotice({ origin: 'https://www.unlinked.ai', graceMs: 60, maxClients: 2 })
  const server = createServer((req, res) => notices.handle(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => { notices.close(); server.closeAllConnections(); return new Promise(r => server.close(r)) })
  const url = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.invalid' } })).status, 403)
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
  const response = await fetch(url), reader = response.body.getReader()
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const decode = value => new TextDecoder().decode(value)
  const first = decode((await reader.read()).value)
  assert.match(first, /"restartingAt":null/)
  const started = Date.now(), wait = notices.announce()
  assert.equal(notices.announce(), wait)
  const notice = decode((await reader.read()).value)
  assert.match(notice, /"restartingAt":\d+/)
  const late = await fetch(url), lateReader = late.body.getReader()
  assert.match(decode((await lateReader.read()).value), /"restartingAt":\d+/)
  assert.equal((await fetch(url)).status, 503)
  await wait
  assert.ok(Date.now() - started >= 55)
  notices.close()
  assert.equal((await reader.read()).done, true)
  assert.equal((await lateReader.read()).done, true)
})

test('client preserves page, stays visible through disconnect, recovers only on new instance and reconnects after bfcache', () => {
  const streams = [], elements = [], timers = [], events = {}
  const context = { EventSource: class { constructor(url) { this.url = url; streams.push(this) } close() { this.closed = true } },
    document: { createElement: () => ({ style: {}, setAttribute() {}, remove() { this.removed = true } }), documentElement: { append: el => elements.push(el) } },
    addEventListener: (name, fn) => { events[name] = fn }, setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {} }
  runInNewContext(RESTART_NOTICE_SCRIPT, context)
  const send = state => streams.at(-1).onmessage({ data: JSON.stringify(state) })
  send({ instance: 'old', restartingAt: null }); assert.equal(elements.length, 0)
  send({ instance: 'old', restartingAt: Date.now() + 5000 }); assert.match(elements[0].textContent, /few seconds/)
  timers[0](); assert.match(elements[0].textContent, /Reconnecting/)
  send({ instance: 'old', restartingAt: null }); assert.match(elements[0].textContent, /Reconnecting/)
  send({ instance: 'new', restartingAt: null }); assert.match(elements[0].textContent, /is back/)
  timers.at(-1)(); assert.ok(elements[0].removed)
  events.pagehide(); assert.ok(streams[0].closed)
  events.pageshow(); assert.equal(streams.length, 2)
})
