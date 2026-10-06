import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { NETWORK_FILTER_SCRIPT } from '../mcp-server/network-filter-script.mjs'

function browser(initial='https://unlinked.invalid/network') {
  const listeners = new Map(), pending = [], location = { origin: 'https://unlinked.invalid', href: initial }
  const document = {
    activeElement: null,
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelector: () => current,
  }
  const makeRoot = (url = new URL(initial)) => {
    const attributes = new Map(), elements = new Map()
    const root = {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      contains: element => [...elements.values()].includes(element),
      querySelector: selector => elements.get(selector),
      querySelectorAll: () => [...elements.values()].filter(e => e.focus),
      replaceWith: next => {
        if (root.contains(document.activeElement)) document.activeElement = null
        current = next
      },
      attributes,
    }
    for (const id of ['network-query', 'network-sort', 'network-filters']) {
      elements.set('#' + id, {
        id, closest: () => null, value: id === 'network-sort' ? (url.searchParams.get('sort') || 'best') : id === 'network-query' ? (url.searchParams.get('q') || '') : '', action: 'https://unlinked.invalid/network', selectionStart: 0, selectionEnd: 0,
        focus: () => { document.activeElement = elements.get('#' + id) },
        replaceWith: element => elements.set('#' + id, element),
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
      })
    }
    for (const [id, textContent, path] of [['member', 'On Unlinked', '?presence=member'], ['all', 'All', ''], ['more', 'Show more', '?page=1&cursor=old']]) {
      const link = { id: '', tagName: 'A', textContent, href: 'https://unlinked.invalid/network' + path, classList: { contains: () => false }, closest: selector => selector === 'a' ? link : selector === '.network-segments' && ['member', 'all'].includes(id) ? {} : null, focus: () => { document.activeElement = link } }
      elements.set('#' + id, link)
    }
    for (const [id, action, profileId, textContent, name, value] of [
      ['ask-ai', '/search-account', null, 'Ask AI across everyone', 'scope', 'everyone'],
      ['connect-ada', '/connections/request', 'ada', 'Connect', '', ''],
      ['connect-grace', '/connections/request', 'grace', 'Connect', '', ''],
    ]) {
      const form = { getAttribute: () => action, querySelector: () => profileId ? { value: profileId } : null }
      const button = { id: '', tagName: 'BUTTON', name, value, type: 'submit', textContent, closest: selector => selector === 'form' ? form : null, focus: () => { document.activeElement = button } }
      elements.set('#' + id, button)
    }
    elements.set('#network-search-help', { textContent: '' })
    elements.set('.network-count', { textContent: '' })
    elements.set('[data-network-results]', { setAttribute: () => {} })
    return root
  }
  let current = makeRoot()
  runInNewContext(NETWORK_FILTER_SCRIPT, {
    document, URL, URLSearchParams, AbortController,
    FormData: class { constructor() { return [['q', current.querySelector('#network-query').value], ['sort', current.querySelector('#network-sort').value]] } },
    fetch: url => new Promise((resolve, reject) => pending.push({ resolve, reject, url: new URL(url) })),
    DOMParser: class { parseFromString() { const next = makeRoot(pending.at(-1).url); return { title: 'People', querySelector: () => next } } },
    history: { pushState(_, __, url) { location.href = String(url) }, replaceState(_, __, url) { location.href = String(url) } },
    location,
    addEventListener: (name, callback) => listeners.set(name, callback),
    clearTimeout, setTimeout,
  })
  const dispatch = (type, target) => {
    const event = { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    listeners.get(type)(event)
    return event
  }
  return { document, pending, dispatch, location, root: () => current }
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

for (const focus of ['sort', 'outside', 'link']) {
  test(`pending membership navigation preserves current ${focus} focus`, async () => {
    const b = browser(), link = b.root().querySelector('#member')
    b.document.activeElement = link
    assert.equal(b.dispatch('click', link).defaultPrevented, true)
    const outside = { id: 'outside' }
    if (focus !== 'link') b.document.activeElement = focus === 'sort' ? b.root().querySelector('#network-sort') : outside
    b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
    await flush()
    assert.equal(b.document.activeElement, focus === 'outside' ? outside : b.root().querySelector(focus === 'sort' ? '#network-sort' : '#member'))
  })
}

test('membership clicked during pending sort uses live sort and query', async () => {
  const b = browser()
  b.root().querySelector('#network-sort').value = 'name-desc'
  b.dispatch('change', b.root().querySelector('#network-sort'))
  b.root().querySelector('#network-query').value = 'Ada'
  b.dispatch('click', b.root().querySelector('#member'))
  assert.deepEqual(Object.fromEntries(b.pending[1].url.searchParams), { q: 'Ada', sort: 'name-desc', presence: 'member' })
  b.pending[1].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  const latest = b.root()
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<stale>' })
  await flush()
  assert.equal(b.root(), latest)
})

test('pagination resets after pending edits and survives when controls are unchanged', () => {
  for (const changed of [false, true]) {
    const b = browser()
    if (changed) b.root().querySelector('#network-sort').value = 'name'
    b.dispatch('click', b.root().querySelector('#more'))
    assert.equal(b.pending[0].url.searchParams.has('page'), !changed)
    assert.equal(b.pending[0].url.searchParams.has('cursor'), !changed)
  }
})

for (const interaction of ['change', 'submit']) {
  test(`pending membership survives subsequent ${interaction}`, async () => {
    const b = browser()
    b.dispatch('click', b.root().querySelector('#member'))
    b.root().querySelector('#network-sort').value = 'name'
    b.dispatch(interaction, b.root().querySelector(interaction === 'change' ? '#network-sort' : '#network-filters'))
    assert.equal(b.pending[1].url.searchParams.get('presence'), 'member')
    assert.equal(b.pending[1].url.searchParams.get('sort'), 'name')
    b.pending[1].resolve({ ok: true, redirected: false, text: async () => '<page>' })
    await flush()
  })
}

test('Back and Forward synchronize a retained focused search field', async () => {
  const b = browser('https://unlinked.invalid/network?q=Ada')
  const input = b.root().querySelector('#network-query')
  input.value = 'Grace'
  input.selectionStart = input.selectionEnd = 3
  b.document.activeElement = input
  b.dispatch('submit', b.root().querySelector('#network-filters'))
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  for (const query of ['Ada', 'Grace']) {
    b.location.href = 'https://unlinked.invalid/network?q=' + query
    b.dispatch('popstate', null)
    b.pending.at(-1).resolve({ ok: true, redirected: false, text: async () => '<page>' })
    await flush()
    assert.equal(b.root().querySelector('#network-query'), input)
    assert.equal(input.value, query)
    assert.equal(b.document.activeElement, input)
    b.root().querySelector('#network-sort').value = 'name'
    b.dispatch('change', b.root().querySelector('#network-sort'))
    assert.equal(b.pending.at(-1).url.searchParams.get('q'), query)
    b.pending.at(-1).resolve({ ok: true, redirected: false, text: async () => '<page>' })
    await flush()
  }
})

for (const id of ['ask-ai', 'connect-ada', 'connect-grace']) {
  test(`membership fetch restores focus on surviving ${id} button`, async () => {
    const b = browser()
    b.dispatch('click', b.root().querySelector('#member'))
    b.document.activeElement = b.root().querySelector('#' + id)
    b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
    await flush()
    assert.equal(b.document.activeElement, b.root().querySelector('#' + id))
  })
}

test('membership can return to rendered All before the first fetch completes', async () => {
  const b = browser()
  b.dispatch('click', b.root().querySelector('#member'))
  b.dispatch('click', b.root().querySelector('#all'))
  assert.equal(b.pending[1].url.searchParams.has('presence'), false)
  b.pending[1].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
})
