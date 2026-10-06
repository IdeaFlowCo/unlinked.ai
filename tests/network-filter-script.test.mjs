import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { NETWORK_FILTER_SCRIPT } from '../mcp-server/network-filter-script.mjs'

function browser() {
  const listeners = new Map(), pending = []
  const document = {
    activeElement: null,
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelector: () => current,
  }
  const makeRoot = () => {
    const attributes = new Map(), elements = new Map()
    const root = {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      contains: element => [...elements.values()].includes(element),
      querySelector: selector => elements.get(selector),
      querySelectorAll: () => [],
      replaceWith: next => {
        if (root.contains(document.activeElement)) document.activeElement = null
        current = next
      },
      attributes,
    }
    for (const id of ['network-query', 'network-sort', 'network-filters']) {
      elements.set('#' + id, {
        id, value: '', action: 'https://unlinked.invalid/network', selectionStart: 0, selectionEnd: 0,
        focus: () => { document.activeElement = elements.get('#' + id) },
        replaceWith: element => elements.set('#' + id, element),
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
      })
    }
    elements.set('#network-search-help', { textContent: '' })
    elements.set('.network-count', { textContent: '' })
    elements.set('[data-network-results]', { setAttribute: () => {} })
    return root
  }
  let current = makeRoot()
  runInNewContext(NETWORK_FILTER_SCRIPT, {
    document, URL, URLSearchParams, AbortController,
    FormData: class { constructor() { return [['q', current.querySelector('#network-query').value], ['sort', 'best']] } },
    fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    DOMParser: class { parseFromString() { const next = makeRoot(); return { title: 'People', querySelector: () => next } } },
    history: { pushState() {}, replaceState() {} },
    location: { origin: 'https://unlinked.invalid' },
    addEventListener: (name, callback) => listeners.set(name, callback),
    clearTimeout, setTimeout,
  })
  const dispatch = (type, target) => {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    listeners.get(type)(event)
    return event
  }
  return { document, pending, dispatch, root: () => current }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('pending filtering restores the current focus after tabbing', async () => {
  const b = browser()
  b.document.activeElement = b.root().querySelector('#network-query')
  assert.equal(b.dispatch('submit', b.root().querySelector('#network-filters')).defaultPrevented, true)
  b.document.activeElement = b.root().querySelector('#network-sort')
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  assert.equal(b.document.activeElement, b.root().querySelector('#network-sort'))
})

test('pending filtering leaves focus outside the directory alone', async () => {
  const b = browser()
  b.document.activeElement = b.root().querySelector('#network-query')
  b.dispatch('submit', b.root().querySelector('#network-filters'))
  const outside = { id: 'outside' }
  b.document.activeElement = outside
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  assert.equal(b.document.activeElement, outside)
})

for (const failure of ['rejected', 'redirected', 'http-error']) {
  test(`native GET submission resumes after ${failure} fetch`, async () => {
    const b = browser()
    const form = b.root().querySelector('#network-filters')
    b.dispatch('submit', form)
    if (failure === 'rejected') b.pending[0].reject(Error('blocked'))
    else if (failure === 'redirected') b.pending[0].resolve({ ok: true, redirected: true })
    else b.pending[0].resolve({ ok: false, redirected: false })
    await flush()
    assert.equal(b.root().attributes.has('data-network-enhanced'), false)
    assert.equal(b.dispatch('submit', form).defaultPrevented, false)
    b.dispatch('change', b.root().querySelector('#network-sort'))
    b.dispatch('input', b.root().querySelector('#network-query'))
    assert.equal(b.pending.length, 1)
  })
}
