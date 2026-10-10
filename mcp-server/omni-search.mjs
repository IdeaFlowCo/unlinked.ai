// Serialized into the page's nonce-bearing header script; no extra bundle or CDN.
function omniSearch() {
  const form = document.querySelector('.header-search')
  if (!form) return
  const input = form.querySelector('input[name=q]')
  const panel = form.querySelector('.omni-panel')
  const list = form.querySelector('[role=listbox]')
  const status = form.querySelector('[role=status]')
  if (!input || !panel || !list || !status) return
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', list.id)
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('autocomplete', 'off')
  // Names are not dictionary words: no iOS autocorrect or capitalization.
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('autocapitalize', 'off')
  input.spellcheck = false
  const signedIn = Boolean(document.querySelector('details.me'))
  const destinations = [
    { name: 'People', subtitle: 'Explore everyone on Unlinked', href: '/network' },
    ...(signedIn ? [
      { name: 'My profile', subtitle: 'Your professional profile', href: '/profile' },
      { name: 'My card', subtitle: 'Share your QR business card', href: '/card' },
      { name: 'Settings', subtitle: 'Account and agent setup', href: '/settings' },
    ] : []),
    { name: 'Scan a card', subtitle: 'Meet someone new', href: '/scan' },
  ]
  let options = [], active = -1, timer, controller, generation = 0, composing = false, tapping = false, warmedAt = 0
  // Answers seen on this page, so retyping or backspacing redraws at once.
  // Memory only: cleared with the page, never stored as history.
  const seen = new Map()
  let shown = {}
  const remember = (term, result) => { seen.delete(term); seen.set(term, result); if (seen.size > 40) seen.delete(seen.keys().next().value) }
  const words = value => value.toLocaleLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean)
  // While the server answers, keep the earlier rows that still fit every typed word.
  const narrow = (term, result) => {
    const typed = words(term), fits = text => { const have = words(text); return typed.every(word => have.some(found => found.startsWith(word))) }
    return { people: (result.people || []).filter(row => fits(row.name + ' ' + (row.headline || ''))), companies: (result.companies || []).filter(row => fits(row.name)) }
  }
  // Focus asks the server to have the directory ready before the first keystroke.
  const warm = () => { if (Date.now() - warmedAt < 10000) return; warmedAt = Date.now(); fetch('/search-suggestions?q=', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {}) }
  const query = () => input.value.trim()
  const cancel = () => { clearTimeout(timer); controller?.abort(); generation++; list.setAttribute('aria-busy', 'false') }
  const activate = index => {
    active = index
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)))
    if (options[index]) {
      input.setAttribute('aria-activedescendant', options[index].id)
      options[index].scrollIntoView({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }
  const close = () => { cancel(); panel.hidden = true; input.setAttribute('aria-expanded', 'false'); activate(-1) }
  const element = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }
  const highlight = (node, text, term) => {
    // Text nodes keep names and queries inert, including markup from published rows.
    const index = term ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1
    if (index < 0) { node.textContent = text; return }
    node.append(document.createTextNode(text.slice(0, index)), element('mark', '', text.slice(index, index + term.length)), document.createTextNode(text.slice(index + term.length)))
  }
  const addGroup = (label, rows, kind, term) => {
    if (!rows.length) return
    const group = element('div', 'omni-group')
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', label)
    const title = element('div', 'omni-heading', label); title.setAttribute('role', 'presentation'); group.append(title)
    for (const row of rows) {
      const option = element('a', 'omni-option')
      option.href = row.href; option.id = 'omni-option-' + options.length
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.tabIndex = -1
      const icon = element('span', 'omni-face' + (kind === 'People' ? '' : ' omni-square'), kind === 'People' ? row.name.split(/\s+/u).slice(0, 2).map(word => [...word][0]).join('') : kind === 'Companies' ? 'Co' : '↗')
      icon.setAttribute('aria-hidden', 'true')
      if (kind === 'People' && /^\/people\/[0-9a-f-]{36}\/photo\?v=[a-f0-9]{16}$/.test(row.photo ?? '')) {
        const img = element('img'); img.src = row.photo; img.alt = ''; img.addEventListener('error', () => img.remove()); icon.append(img)
      }
      const copy = element('span', 'omni-copy'), name = element('span', 'omni-name')
      highlight(name, row.name, term)
      copy.append(name, element('span', 'omni-subtitle', row.subtitle || kind))
      option.append(icon, copy)
      // Keep DOM focus on the combobox so pointer selection and keyboard agree.
      option.addEventListener('pointerdown', event => { if (event.button === 0 && event.pointerType !== 'touch') event.preventDefault() })
      const index = options.length
      option.addEventListener('pointermove', () => { if (active !== index) activate(index) })
      options.push(option); group.append(option)
    }
    list.append(group)
  }
  // Same URL the native form submits, including its hidden filters.
  const fullSearch = term => {
    const params = new URLSearchParams(new FormData(form))
    params.set('q', term)
    return '/network?' + params
  }
  const draw = (term, result = {}, message = '') => {
    options = []; active = -1; input.removeAttribute('aria-activedescendant'); list.replaceChildren()
    const people = Array.isArray(result.people) ? result.people.slice(0, 5) : []
    const companies = Array.isArray(result.companies) ? result.companies.slice(0, 3) : []
    addGroup('People', people.map(row => ({ name: row.name, subtitle: row.headline || row.location || 'View profile', photo: row.photo, href: '/people/' + encodeURIComponent(row.id) })), 'People', term)
    addGroup('Companies', companies.map(row => ({ name: row.name, subtitle: 'Company · View people and details', href: '/companies/' + encodeURIComponent(row.name) })), 'Companies', term)
    const shortcuts = destinations.filter(row => !term || row.name.toLowerCase().includes(term.toLowerCase()))
    addGroup('Go to', shortcuts, 'Go to', term)
    if (term) addGroup('Search', [{ name: 'See all results for “' + term + '”', subtitle: 'People, roles, companies and skills', href: fullSearch(term) }], 'Search', '')
    status.textContent = message || (term.length < 2 ? 'Search people, roles and companies, or jump to a page.' : people.length + companies.length ? (people.length + companies.length) + ' suggestions. Use ↑ ↓ to choose, Enter to open.' : 'No matching people or companies. Try the full search.')
    panel.hidden = false; input.setAttribute('aria-expanded', 'true')
  }
  const update = () => {
    cancel()
    if (composing || document.activeElement !== input) return
    const term = query(), current = generation
    if (term.length < 2) { draw(term); return }
    if (seen.has(term)) { shown = seen.get(term); draw(term, shown); return }
    draw(term, narrow(term, shown), 'Finding people and companies…')
    list.setAttribute('aria-busy', 'true')
    timer = setTimeout(async () => {
      const requestController = new AbortController()
      controller = requestController
      const timeout = setTimeout(() => requestController.abort(), 6000)
      try {
        const response = await fetch('/search-suggestions?' + new URLSearchParams({ q: term }), { signal: requestController.signal, credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('suggestions_unavailable')
        const result = await response.json()
        remember(term, result)
        if (current === generation && document.activeElement === input) { shown = result; draw(term, result) }
      } catch {
        if (current === generation && document.activeElement === input) draw(term, {}, 'Suggestions unavailable. Press Enter to search all results.')
      } finally {
        clearTimeout(timeout)
        if (current === generation) list.setAttribute('aria-busy', 'false')
      }
    }, 120)
  }
  input.addEventListener('focus', () => { warm(); update() })
  input.addEventListener('input', update)
  input.addEventListener('compositionstart', () => { composing = true; close() })
  input.addEventListener('compositionend', () => { composing = false; update() })
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing) return
    if (event.key === 'Escape') { event.preventDefault(); close() }
    else if (event.key === 'Tab') close()
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (panel.hidden) { update(); return }
      if (options.length) activate(event.key === 'ArrowDown' ? (active + 1) % options.length : (active <= 0 ? options.length : active) - 1)
    } else if (event.key === 'Enter' && !panel.hidden && options[active]) { event.preventDefault(); options[active].click() }
  })
  form.addEventListener('submit', close)
  // A tap on a suggestion may blur the field (iOS) before its click arrives;
  // keep the panel until that click navigates.
  panel.addEventListener('pointerdown', () => { tapping = true; setTimeout(() => { tapping = false }, 800) })
  panel.addEventListener('pointercancel', () => { tapping = false })
  form.addEventListener('focusout', event => { if (!tapping && !form.contains(event.relatedTarget)) close() })
  document.addEventListener('pointerdown', event => { if (!form.contains(event.target)) close() })
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.altKey) { event.preventDefault(); input.focus(); input.select(); if (panel.hidden) update() }
  })
  addEventListener('pagehide', close)
}
export const OMNI_SEARCH_SCRIPT = `(${omniSearch.toString()})();`
