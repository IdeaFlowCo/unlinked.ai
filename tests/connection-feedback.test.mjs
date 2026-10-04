import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { CONNECTION_FEEDBACK_SCRIPT } from '../mcp-server/connection-feedback.mjs'

function browser({ counts = { network: 2, notifications: 3 }, status = 200 } = {}) {
  const events = {}, windowEvents = {}, timers = [], intervals = [], requests = [], elements = []
  const element = () => ({ attributes: {}, children: [], textContent: '', innerHTML: '', disabled: false,
    setAttribute(key, value) { this.attributes[key] = value }, removeAttribute(key) { delete this.attributes[key] },
    append(child) { this.children.push(child); child.parent = this }, remove() { this.parent.children = this.parent.children.filter(x => x !== this) },
    querySelector() { return this.children.find(x => x.className === 'badge') ?? null } })
  const network = element(), notifications = element()
  const document = { hidden: false, addEventListener: (name, fn) => { events[name] = fn }, createElement: element,
    querySelector: selector => selector.includes('/invitations') ? network : notifications }
  const window = { addEventListener: (name, fn) => { windowEvents[name] = fn } }
  runInNewContext(CONNECTION_FEEDBACK_SCRIPT, { document, window, Date, AbortController,
    setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {}, setInterval: fn => intervals.push(fn),
    fetch: async (url, options) => { requests.push({ url, options }); return { status, ok: status === 200, json: async () => counts } } })
  const form = () => { const f = element(); f.matches = () => true; const button = element(); button.type = 'submit'; button.innerHTML = 'Connect'; f.elements = [button]; elements.push(f); return f }
  const submit = (target, extra = {}) => { const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }; events.submit(event); return event }
  return { document, events, windowEvents, intervals, requests, form, submit, network, notifications }
}

test('Connect gives immediate accessible feedback, blocks duplicate submits, and recovers on browser Back', () => {
  const b = browser(), form = b.form(), other = b.form()
  assert.equal(b.submit(form).defaultPrevented, false) // Preserve the native form POST.
  assert.equal(form.elements[0].disabled, true)
  assert.equal(form.elements[0].textContent, 'Sending…')
  assert.equal(form.attributes['aria-busy'], 'true')
  assert.equal(form.children[0].attributes.role, 'status')
  assert.equal(other.elements[0].disabled, false)
  assert.equal(b.submit(form).defaultPrevented, true)
  b.windowEvents.pageshow()
  assert.equal(form.elements[0].disabled, false)
  assert.equal(form.elements[0].innerHTML, 'Connect')
  assert.equal(form.children.length, 0)
  assert.equal(b.submit(form).defaultPrevented, false)
})

test('an already cancelled submit and unrelated forms are left alone', () => {
  const b = browser(), form = b.form()
  b.submit(form, { defaultPrevented: true }); assert.equal(form.elements[0].disabled, false)
  form.matches = () => false; b.submit(form); assert.equal(form.elements[0].disabled, false)
})

test('live badge refresh uses the session, updates visible and accessible counts, and pauses while hidden', async () => {
  const b = browser({ counts: { network: 2, notifications: 140 } })
  b.document.hidden = true; await b.intervals[0](); assert.equal(b.requests.length, 0)
  b.document.hidden = false; await b.events.visibilitychange()
  assert.equal(b.requests[0].url, '/api/nav-alerts'); assert.equal(b.requests[0].options.cache, 'no-store')
  assert.equal(b.requests[0].options.credentials, 'same-origin')
  assert.equal(b.network.attributes['aria-label'], 'My Network, 2 pending')
  assert.equal(b.notifications.attributes['aria-label'], 'Notifications, 99+ new')
  assert.equal(b.notifications.children[0].textContent, '99+')
  await b.windowEvents.focus(); assert.equal(b.requests.length, 1) // Coalesce focus + visibility.
})

test('unavailable counts retain the last badge and signed-out refreshes stop without following login', async () => {
  const b = browser({ counts: { network: null, notifications: null } })
  b.notifications.setAttribute('aria-label', 'Notifications, 4 new')
  await b.intervals[0](); assert.equal(b.notifications.attributes['aria-label'], 'Notifications, 4 new')
  const signedOut = browser({ status: 401 }); await signedOut.intervals[0](); assert.equal(signedOut.requests.length, 1)
  await signedOut.windowEvents.focus(); assert.equal(signedOut.requests.length, 1)
})

test('a zero count removes an old badge after reading notifications elsewhere', async () => {
  const b = browser({ counts: { network: 0, notifications: 0 } })
  const old = b.form(); old.className = 'badge'; b.notifications.append(old)
  await b.intervals[0]()
  assert.equal(b.notifications.children.length, 0)
  assert.equal(b.notifications.attributes['aria-label'], 'Notifications')
})
