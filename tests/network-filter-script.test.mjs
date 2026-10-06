import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { NETWORK_FILTER_SCRIPT } from '../mcp-server/network-filter-script.mjs'

function browser(initial='https://unlinked.invalid/network') {
  const listeners = new Map(), pending = [], location = { origin: 'https://unlinked.invalid', href: initial }
  const historyEntries = ['https://unlinked.invalid/before-directory', initial]
  let historyIndex = 1
  const history = {
    pushState(_, __, url) { historyEntries.splice(historyIndex + 1); historyEntries.push(String(url)); historyIndex++; location.href = String(url) },
    replaceState(_, __, url) { historyEntries[historyIndex] = String(url); location.href = String(url) },
    back() { if (historyIndex > 0) { location.href = historyEntries[--historyIndex]; listeners.get('popstate')() } },
    forward() { if (historyIndex + 1 < historyEntries.length) { location.href = historyEntries[++historyIndex]; listeners.get('popstate')() } },
  }
  const document = {
    activeElement: null,
    createElement: tag => ({ tagName: tag.toUpperCase(), value: '' }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelector: () => current,
  }
  const makeRoot = (url = new URL(initial)) => {
    const attributes = new Map(), elements = new Map(), hidden = new Map(), disclosures = []
    const root = {
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      contains: element => [...elements.values()].includes(element),
      querySelector: selector => elements.get(selector),
      querySelectorAll: selector => selector === 'details' ? disclosures : selector === 'details[open]' ? disclosures.filter(d => d.open) : [...elements.values()].filter(e => e.focus),
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
    const sort = elements.get('#network-sort')
    const selectedSort = sort.value
    sort.options = []
    sort.append = option => { sort.options.push(option); option.remove = () => { sort.options = sort.options.filter(item => item !== option) } }
    for (const value of ['best', 'name', 'name-desc', ...(url.searchParams.get('connected') === '1' ? ['connected', 'imported'] : [])]) sort.append({ value })
    let sortValue = ''
    Object.defineProperty(sort, 'value', { get: () => sort.options.some(option => option.value === sortValue) ? sortValue : '', set: value => { sortValue = sort.options.some(option => option.value === value) ? value : '' } })
    sort.value = selectedSort
    const form = elements.get('#network-filters')
    form.querySelector = selector => hidden.get(selector.match(/name="([^"]+)"/)?.[1])
    form.append = field => { hidden.set(field.name, field); field.remove = () => hidden.delete(field.name) }
    form.fields = hidden
    for (const key of ['presence', 'connected', 'mode', 'scope']) if (url.searchParams.has(key)) form.append({ name: key, value: url.searchParams.get(key) })
    for (const [id, textContent, path] of [['member', 'On Unlinked', '?presence=member'], ['all', 'All', ''], ['more', 'Show more', '?page=1&cursor=old'], ['everyone', 'Everyone', ''], ['connections', 'My connections', '?connected=1'], ['clear-search', 'Clear search', ''], ['clear-filters', 'Clear filters', '']]) {
      const link = { id: '', tagName: 'A', textContent, href: 'https://unlinked.invalid/network' + path, classList: { contains: name => name === 'network-reset' && id === 'clear-filters' }, closest: selector => selector === 'a' ? link : selector === '.network-segments' && ['member', 'all'].includes(id) ? {} : selector === '.network-scopes' && ['everyone', 'connections'].includes(id) ? {} : null, focus: () => { document.activeElement = link } }
      elements.set('#' + id, link)
    }
    for (const [id, action, profileId, textContent, name, value] of [
      ['ask-ai', '/search-account', null, 'Ask AI across everyone', 'scope', 'everyone'],
      ['connect-ada', '/connections/request', 'ada', 'Connect', '', ''],
      ['connect-grace', '/connections/request', 'grace', 'Connect', '', ''],
      ['connect-ada-everyone', '/connections/request', 'ada', 'Connect', '', ''],
      ['remove-ada', '/connections/remove', 'ada', 'Confirm removal', '', ''],
      ['remove-ada-second-import', '/connections/remove', 'ada', 'Confirm removal', '', ''],
    ]) {
      const section = { getAttribute: () => id.endsWith('-everyone') ? 'everyone-group' : 'own-group' }
      const form = { getAttribute: () => action, querySelector: () => profileId ? { value: profileId } : null }
      const row = { getAttribute: name => name === 'data-network-row' ? (id === 'remove-ada-second-import' ? 'second-assertion' : 'first-assertion') : null, querySelector: () => profileId ? { getAttribute: () => '/people/' + profileId } : null }
      const button = { id: '', tagName: 'BUTTON', name, value, type: 'submit', textContent, closest: selector => selector === 'form' ? form : selector === 'section[aria-label]' ? section : selector === 'article' ? row : null, focus: () => { if (!button.disclosure || button.disclosure.open) document.activeElement = button } }
      elements.set('#' + id, button)
      if (id.startsWith('remove-ada')) {
        const summary = { ...button, tagName: 'SUMMARY', textContent: 'Remove connection', focus: () => { document.activeElement = summary } }
        const details = { open: false, querySelector: () => summary }
        button.disclosure = details
        disclosures.push(details)
        elements.set(id === 'remove-ada' ? '#remove-summary' : '#remove-summary-second-import', summary)
      }
    }
    elements.set('#network-search-help', { textContent: '' })
    elements.set('.network-count', { textContent: '' })
    elements.set('[data-network-results]', { setAttribute: () => {} })
    return root
  }
  let current = makeRoot()
  runInNewContext(NETWORK_FILTER_SCRIPT, {
    document, URL, URLSearchParams, AbortController,
    FormData: class { constructor() { return [['q', current.querySelector('#network-query').value], ['sort', current.querySelector('#network-sort').value], ...[...current.querySelector('#network-filters').fields.values()].map(field => [field.name, field.value])] } },
    fetch: (url, options) => new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal, url: new URL(url) })),
    DOMParser: class { parseFromString() { const next = makeRoot(pending.at(-1).url); return { title: 'People', querySelector: () => next } } },
    history,
    location,
    addEventListener: (name, callback) => listeners.set(name, callback),
    clearTimeout, setTimeout,
  })
  const dispatch = (type, target) => {
    const event = { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    listeners.get(type)(event)
    return event
  }
  return { document, pending, dispatch, location, history, historyEntries, root: () => current }
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

for (const path of ['/ask', '/search-account']) {
  test(`live filtering from ${path} submits to the native directory action`, () => {
    const b = browser('https://unlinked.invalid' + path + '?q=Ada&presence=member')
    b.root().querySelector('#network-query').value = 'Grace'
    b.dispatch('submit', b.root().querySelector('#network-filters'))
    assert.equal(b.pending[0].url.pathname, '/network')
    assert.equal(b.pending[0].url.searchParams.get('presence'), 'member')
    assert.equal(b.pending[0].url.searchParams.get('q'), 'Grace')
  })
}

test('duplicate profile actions retain focus in the same result section', async () => {
  const b = browser()
  b.dispatch('click', b.root().querySelector('#member'))
  b.document.activeElement = b.root().querySelector('#connect-ada-everyone')
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  assert.equal(b.document.activeElement, b.root().querySelector('#connect-ada-everyone'))
})

test('surviving open removal disclosure remains open and keeps confirmation focus', async () => {
  const b = browser()
  b.dispatch('click', b.root().querySelector('#member'))
  const button = b.root().querySelector('#remove-ada')
  button.disclosure.open = true
  button.focus()
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  const next = b.root().querySelector('#remove-ada')
  assert.equal(next.disclosure.open, true)
  assert.equal(b.document.activeElement, next)
})

test('failed membership change preserves pending fields for native retry', async () => {
  const b = browser()
  b.dispatch('click', b.root().querySelector('#member'))
  b.pending[0].reject(Error('offline'))
  await flush()
  const form = b.root().querySelector('#network-filters')
  assert.equal(b.dispatch('submit', form).defaultPrevented, false)
  assert.equal(form.fields.get('presence').value, 'member')
})

test('history failure retains a private date sort in native retry even before options arrive', async () => {
  const b = browser()
  b.location.href = 'https://unlinked.invalid/network?connected=1&sort=connected'
  b.dispatch('popstate', null)
  b.pending[0].reject(Error('offline'))
  await flush()
  const form = b.root().querySelector('#network-filters'), sort = b.root().querySelector('#network-sort')
  assert.equal(b.dispatch('submit', form).defaultPrevented, false)
  assert.equal(form.fields.get('connected').value, '1')
  assert.equal(sort.value, 'connected')
  assert.ok(sort.options.some(option => option.value === 'connected'))
})

for (const sort of ['connected', 'imported']) {
  for (const interaction of ['membership', 'typing']) {
    test(`history synchronizes ${sort} options before pending ${interaction}`, async () => {
      const b = browser()
      b.location.href = `https://unlinked.invalid/network?connected=1&sort=${sort}`
      b.dispatch('popstate', null)
      assert.equal(b.root().querySelector('#network-sort').value, sort)
      if (interaction === 'membership') b.dispatch('click', b.root().querySelector('#member'))
      else {
        b.root().querySelector('#network-query').value = 'Ada'
        b.dispatch('input', b.root().querySelector('#network-query'))
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      assert.equal(b.pending[1].url.searchParams.get('sort'), sort)
      assert.equal(b.pending[1].url.searchParams.get('connected'), '1')
      b.pending[1].resolve({ ok: true, redirected: false, text: async () => '<page>' })
      await flush()
      assert.equal(b.root().querySelector('#network-sort').value, sort)
      assert.equal(b.root().querySelector('#network-sort').options.some(option => option.value === 'imported'), true)
    })
  }
}

for (const clear of ['clear-search', 'clear-filters']) {
  test(`${clear} preserves pending connection scope and resets pagination`, () => {
    const b = browser('https://unlinked.invalid/network?q=Ada&mode=exact&page=2&cursor=old')
    b.dispatch('click', b.root().querySelector('#connections'))
    b.dispatch('click', b.root().querySelector('#member'))
    b.root().querySelector('#network-sort').value = 'imported'
    b.dispatch('change', b.root().querySelector('#network-sort'))
    b.root().querySelector('#network-query').value = 'Grace'
    b.dispatch('click', b.root().querySelector('#' + clear))
    assert.deepEqual(Object.fromEntries(b.pending.at(-1).url.searchParams), clear === 'clear-search' ? { sort: 'imported', connected: '1', presence: 'member' } : { connected: '1' })
    assert.equal(b.root().querySelector('#network-query').value, '')
    assert.equal(b.root().querySelector('#network-sort').value, clear === 'clear-search' ? 'imported' : 'best')
  })

  test(`${clear} preserves pending Everyone scope over rendered connections`, () => {
    const b = browser('https://unlinked.invalid/network?connected=1&q=Ada&presence=member&sort=connected')
    b.dispatch('click', b.root().querySelector('#everyone'))
    b.root().querySelector('#network-sort').value = 'name-desc'
    b.dispatch('click', b.root().querySelector('#' + clear))
    assert.deepEqual(Object.fromEntries(b.pending.at(-1).url.searchParams), clear === 'clear-search' ? { presence: 'member', sort: 'name-desc' } : {})
  })
}

test('successful history navigation restores date options and subsequent sorting', async () => {
  const b = browser()
  b.location.href = 'https://unlinked.invalid/network?connected=1&sort=connected'
  b.dispatch('popstate', null)
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  const sort = b.root().querySelector('#network-sort')
  assert.equal(sort.value, 'connected')
  sort.value = 'imported'
  b.dispatch('change', sort)
  assert.equal(b.pending[1].url.searchParams.get('sort'), 'imported')
  assert.equal(b.pending[1].url.searchParams.get('connected'), '1')
})

for (const clear of ['clear-search', 'clear-filters']) {
  test(`${clear} resets pending pagination`, () => {
    const b = browser('https://unlinked.invalid/network?q=Ada&presence=member&sort=name')
    b.dispatch('click', b.root().querySelector('#more'))
    assert.equal(b.pending[0].url.searchParams.get('page'), '1')
    assert.equal(b.pending[0].url.searchParams.get('cursor'), 'old')
    b.dispatch('click', b.root().querySelector('#' + clear))
    assert.equal(b.pending[1].url.searchParams.has('page'), false)
    assert.equal(b.pending[1].url.searchParams.has('cursor'), false)
  })
}

test('duplicate imported rows restore only the second open disclosure and confirmation focus', async () => {
  const b = browser()
  b.dispatch('click', b.root().querySelector('#member'))
  const second = b.root().querySelector('#remove-ada-second-import')
  second.disclosure.open = true
  second.focus()
  b.pending[0].resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
  assert.equal(b.root().querySelector('#remove-ada').disclosure.open, false)
  assert.equal(b.root().querySelector('#remove-ada-second-import').disclosure.open, true)
  assert.equal(b.document.activeElement, b.root().querySelector('#remove-ada-second-import'))
})

const typeQuery = async (b, query) => {
  const input = b.root().querySelector('#network-query')
  input.value = query
  b.dispatch('input', input)
  await new Promise(resolve => setTimeout(resolve, 350))
}
const finishLatest = async b => {
  b.pending.at(-1).resolve({ ok: true, redirected: false, text: async () => '<page>' })
  await flush()
}

test('cancelled first typing fetch preserves the original history entry and Back target', async () => {
  const initial = 'https://unlinked.invalid/network?presence=member'
  const b = browser(initial)
  await typeQuery(b, 'Ada')
  assert.equal(b.historyEntries.length, 2)
  const first = b.pending[0]
  await typeQuery(b, 'Grace')
  assert.equal(first.signal.aborted, true)
  await finishLatest(b)
  assert.equal(b.historyEntries.length, 3)
  assert.equal(b.historyEntries[1], initial)
  assert.equal(new URL(b.historyEntries[2]).searchParams.get('q'), 'Grace')
  first.resolve({ ok: true, redirected: false, text: async () => '<stale>' })
  await flush()
  await typeQuery(b, 'Grace Hopper')
  await finishLatest(b)
  assert.equal(b.historyEntries.length, 3)
  assert.equal(new URL(b.historyEntries[2]).searchParams.get('q'), 'Grace Hopper')
  b.history.back()
  assert.equal(b.location.href, initial)
  await finishLatest(b)
  assert.equal(b.root().querySelector('#network-query').value, '')
  assert.equal(b.pending.at(-1).url.searchParams.get('presence'), 'member')
  b.history.forward()
  await finishLatest(b)
  assert.equal(b.root().querySelector('#network-query').value, 'Grace Hopper')
})

for (const boundary of ['link', 'sort', 'submit', 'popstate']) {
  test(`typing starts a new history entry after ${boundary}`, async () => {
    const b = browser()
    await typeQuery(b, 'Ada')
    await finishLatest(b)
    if (boundary === 'link') b.dispatch('click', b.root().querySelector('#member'))
    else if (boundary === 'sort') {
      b.root().querySelector('#network-sort').value = 'name'
      b.dispatch('change', b.root().querySelector('#network-sort'))
    } else if (boundary === 'submit') b.dispatch('submit', b.root().querySelector('#network-filters'))
    else b.history.back()
    await finishLatest(b)
    const previous = b.location.href
    await typeQuery(b, 'Grace')
    await finishLatest(b)
    assert.equal(new URL(b.location.href).searchParams.get('q'), 'Grace')
    b.history.back()
    assert.equal(b.location.href, previous)
    await finishLatest(b)
  })
}

test('failed first typing fetch leaves committed history unchanged', async () => {
  const b = browser('https://unlinked.invalid/network?presence=member')
  const original = [...b.historyEntries]
  await typeQuery(b, 'Ada')
  b.pending[0].reject(Error('offline'))
  await flush()
  assert.deepEqual(b.historyEntries, original)
  assert.equal(b.location.href, original.at(-1))
})
