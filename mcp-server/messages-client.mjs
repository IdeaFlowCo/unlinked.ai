// The Unlinked-native Messages client (docs/openchat-message.md). It runs in the
// page's nonce'd script and talks only to this origin: `/messages/api/*` JSON
// and the `/messages/api/stream` event stream. OpenChat stays the message store;
// nothing here holds an OpenChat credential. All text is rendered with
// textContent, never as HTML.

function messagesClient(config) {
  const root = document.getElementById('msg-app')
  if (!root) return
  const $ = id => document.getElementById(id)
  const listEl = $('msg-list'), threadEl = $('msg-thread'), statusEl = $('msg-status'), filterEl = $('msg-filter')
  const FIVE_MINUTES = 5 * 60000, REACTIONS = config.reactions
  const counted = new Set()
  const state = {
    me: null, conversations: new Map(), threads: new Map(), open: null, loadedAt: new Date().toISOString(), readMaps: new Map(),
    stream: null, streamState: 'connecting', filter: '', unreadFirst: false, retryMs: 2000, retryTimer: null, paused: false,
    replyTo: null, editing: null, typing: new Map(), markedUnread: new Set(), newBelow: false, people: null,
  }

  // ── Local preferences (this browser only) ──────────────────────────────────
  const store = {
    get(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback } catch { return fallback } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Private mode or full: preferences stay in memory. */ } },
  }
  const prefs = store.get('unlinked.messages.prefs', { enterSends: true })
  const drafts = store.get('unlinked.messages.drafts', {})
  const profiles = store.get('unlinked.messages.profiles', {})
  const saveDraft = (id, text) => { if (!id) return; if (text) drafts[id] = text.slice(0, 8000); else delete drafts[id]; store.set('unlinked.messages.drafts', drafts) }
  // A profile Message link opens /messages/c/<id>#profile=<public id>: remember it for "View on Unlinked".
  const hashProfile = /^#profile=([A-Za-z0-9._~%-]{1,480})$/.exec(location.hash)
  if (hashProfile && config.conversationId) { try { profiles[config.conversationId] = decodeURIComponent(hashProfile[1]); store.set('unlinked.messages.profiles', profiles) } catch { /* Ignore a malformed hash. */ } history.replaceState(history.state, '', location.pathname) }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') el.className = value
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
      else el.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : document.createTextNode(String(child)))
    return el
  }
  const HUES = ['#4349c4', '#2f6f8f', '#8a5a2b', '#6b4fa0', '#b0413e', '#3d6f7a']
  const hue = seed => { let hash = 0; for (const character of String(seed || '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0; return HUES[hash % HUES.length] }
  const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase()
  const avatar = (name, seed, presence) => h('span', { class: 'msg-avatar', style: `background:${hue(seed)}`, 'aria-hidden': 'true' }, initials(name) || '·', presence === 'available' || presence === 'away' ? h('span', { class: `msg-dot ${presence}` }) : null)
  // Links become anchors; everything else stays text.
  function linkify(text) {
    const parts = [], pattern = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g
    let last = 0, match
    while ((match = pattern.exec(text))) {
      if (match.index > last) parts.push(text.slice(last, match.index))
      parts.push(h('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer' }, match[0]))
      last = match.index + match[0].length
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts
  }
  const time = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  function ago(at) {
    if (!at) return ''
    const seconds = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
    if (seconds < 60) return 'now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
    if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`
    return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  function dayLabel(at) {
    const day = new Date(at), today = new Date(), yesterday = new Date(Date.now() - 86400000)
    const same = (a, b) => a.toDateString() === b.toDateString()
    return same(day, today) ? 'Today' : same(day, yesterday) ? 'Yesterday' : day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
  }
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))
  const announce = text => { const live = $('msg-announce'); if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text }, 30) } }

  // ── Server calls ───────────────────────────────────────────────────────────
  async function api(path, body) {
    const response = await fetch(`/messages/api${path}`, body === undefined
      ? { credentials: 'same-origin', headers: { Accept: 'application/json' } }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Unlinked-CSRF': config.csrf }, body: JSON.stringify(body) })
    if (response.status === 401) { showStatus('Your session ended.', { href: `/login?next=${encodeURIComponent(location.pathname)}`, label: 'Sign in again' }); throw Error('signed_out') }
    if (!response.ok) throw Object.assign(Error('request_failed'), { status: response.status })
    return response.json()
  }
  function showStatus(text, action) {
    statusEl.replaceChildren(text, action ? ' ' : '', action ? h('a', { href: action.href }, action.label) : '')
    statusEl.hidden = !text
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  const others = conversation => conversation.participants.filter(person => person.id !== state.me)
  const titleOf = conversation => conversation.title || others(conversation).map(person => person.name).join(', ') || 'Just you'
  const peerOf = conversation => conversation.type === 'direct' ? others(conversation)[0] : null
  const muted = conversation => conversation.mutedUntil === 'always' || (conversation.mutedUntil && Date.parse(conversation.mutedUntil) > Date.now())
  const unreadOf = conversation => state.markedUnread.has(conversation.id) ? Math.max(1, conversation.unreadCount || 0) : conversation.unreadCount || 0
  const sorted = () => [...state.conversations.values()].sort((a, b) => (state.unreadFirst ? (unreadOf(b) > 0) - (unreadOf(a) > 0) : 0) || String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')))

  async function loadConversations() {
    try {
      const value = await api('/conversations')
      state.me = value.me.id
      const previous = state.conversations
      state.conversations = new Map(value.conversations.map(conversation => [conversation.id, conversation]))
      // Keep this tab's own read of the open thread until OpenChat reflects it.
      if (state.open && previous.get(state.open) && state.conversations.get(state.open) && document.visibilityState === 'visible') state.conversations.get(state.open).unreadCount = 0
      renderList(); updateUnread()
      if (state.open && !state.threads.has(state.open)) openConversation(state.open, { push: false })
      else if (state.open) renderThreadHeader()
    } catch (error) {
      if (error.message !== 'signed_out') { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'Messages are unavailable right now. ', h('button', { class: 'link-button', type: 'button', onclick: () => { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'Loading…')); loadConversations() } }, 'Try again'))) }
    }
  }

  function renderList() {
    const items = sorted().filter(conversation => !state.filter || `${titleOf(conversation)} ${conversation.lastMessage?.content || ''}`.toLowerCase().includes(state.filter))
    const toggle = $('msg-unread-first')
    if (toggle) toggle.setAttribute('aria-pressed', String(state.unreadFirst))
    if (!state.conversations.size) { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'No conversations yet. ', h('a', { href: '/network' }, 'Message someone from People →'))); return }
    if (!items.length) { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'No results')); return }
    listEl.replaceChildren(...items.map(conversation => {
      const peer = peerOf(conversation), title = titleOf(conversation), last = conversation.lastMessage
      const typingNames = typingIn(conversation.id)
      const preview = typingNames.length ? 'typing…' : last ? `${last.senderId === state.me ? 'You: ' : ''}${last.content || 'Attachment'}` : 'No messages yet'
      const unread = conversation.id !== state.open ? unreadOf(conversation) : 0
      return h('li', {},
        h('a', { class: `msg-item${conversation.id === state.open ? ' active' : ''}${unread ? ' unread' : ''}`, href: `/messages/c/${encodeURIComponent(conversation.id)}`, 'data-id': conversation.id, 'aria-current': conversation.id === state.open ? 'page' : null, onclick: event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openConversation(conversation.id) } },
          avatar(title, peer?.id || conversation.id, peer?.presence),
          h('span', { class: 'msg-item-body' },
            h('span', { class: 'msg-item-top' }, h('b', { class: 'msg-item-name' }, title), peer?.isBot || conversation.containsBot ? h('span', { class: 'msg-tag' }, 'Bot') : null, muted(conversation) ? h('span', { class: 'msg-muted', title: 'Muted', 'aria-label': 'Muted' }, '🔕') : null, h('span', { class: 'msg-item-time' }, ago(conversation.lastMessageAt))),
            h('span', { class: `msg-item-preview${typingNames.length ? ' typing' : ''}` }, preview)),
          unread ? h('span', { class: 'msg-pill', 'aria-label': `${unread} unread` }, unread > 99 ? '99+' : unread) : null))
    }))
  }

  function updateUnread() {
    const total = [...state.conversations.values()].reduce((sum, conversation) => sum + (conversation.id === state.open && document.visibilityState === 'visible' ? 0 : unreadOf(conversation)), 0)
    document.title = `${total ? `(${total > 99 ? '99+' : total}) ` : ''}Messages · Unlinked`
    const nav = document.querySelector('[data-nav-messages]')
    if (nav) {
      nav.querySelector('.nav-count')?.remove()
      if (total) nav.append(h('span', { class: 'nav-count', 'aria-label': `${total} unread` }, total > 99 ? '99+' : total))
    }
  }

  // ── Typing (others) ────────────────────────────────────────────────────────
  function typingIn(conversationId) {
    const entries = state.typing.get(conversationId)
    if (!entries) return []
    const conversation = state.conversations.get(conversationId)
    return [...entries.entries()].filter(([, until]) => until > Date.now()).map(([userId]) => conversation?.participants.find(person => person.id === userId)?.name || 'Someone')
  }
  function renderTyping() {
    const el = $('msg-typing')
    if (!el) return
    const names = typingIn(state.open)
    el.textContent = !names.length ? '' : names.length === 1 ? `${names[0].split(' ')[0]} is typing…` : `${names.length} people are typing…`
  }
  setInterval(() => { let changed = false; for (const [id, entries] of state.typing) for (const [userId, until] of entries) if (until <= Date.now()) { entries.delete(userId); changed = true; if (!entries.size) state.typing.delete(id) } if (changed) { renderTyping(); renderList() } }, 1000)

  // ── Thread ─────────────────────────────────────────────────────────────────
  function threadShell() {
    threadEl.replaceChildren(
      h('div', { class: 'msg-thread-head', id: 'msg-thread-head' }),
      h('div', { class: 'msg-log', id: 'msg-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', tabindex: '0' }, h('p', { class: 'msg-loading' }, 'Loading…')),
      h('button', { class: 'msg-jump', id: 'msg-jump', type: 'button', hidden: true, onclick: () => { const log = $('msg-log'); log.scrollTop = log.scrollHeight; hideJump() } }, '↓ New messages'),
      h('div', { class: 'msg-typing', id: 'msg-typing', 'aria-live': 'polite' }),
      composer())
  }
  async function openConversation(id, { push = true } = {}) {
    if (state.open && state.open !== id) { stopTyping(); saveDraft(state.open, $('msg-input')?.value.trim() || '') }
    state.open = id; state.replyTo = null; state.editing = null; state.newBelow = false
    state.markedUnread.delete(id)
    root.dataset.open = id
    if (push && location.pathname !== `/messages/c/${id}`) history.pushState({ id }, '', `/messages/c/${encodeURIComponent(id)}`)
    renderList()
    const conversation = state.conversations.get(id)
    threadShell()
    renderThreadHeader()
    if (!conversation && state.me) { $('msg-log').replaceChildren(h('p', { class: 'msg-loading' }, 'This conversation is not available.')); return }
    api(`/conversations/${encodeURIComponent(id)}/focus`, {}).catch(() => {})
    try {
      if (!state.threads.has(id)) { const page = await api(`/conversations/${encodeURIComponent(id)}/messages`); state.threads.set(id, { items: page.messages, hasMore: page.hasMore }) }
      if (state.open !== id) return
      renderMessages({ scroll: 'bottom' })
      $('msg-log')?.focus({ preventScroll: true })
      if (matchMedia('(pointer: fine)').matches) $('msg-input')?.focus({ preventScroll: true })
      maybeMarkRead()
    } catch (error) {
      if (state.open === id && error.message !== 'signed_out') $('msg-log').replaceChildren(h('p', { class: 'msg-loading' }, 'Messages could not load. ', h('button', { class: 'link-button', type: 'button', onclick: () => openConversation(id, { push: false }) }, 'Try again')))
    }
  }

  function closeConversation({ push = true } = {}) {
    if (state.open) { stopTyping(); saveDraft(state.open, $('msg-input')?.value.trim() || '') }
    const previous = state.open
    state.open = null
    delete root.dataset.open
    if (push) history.pushState({}, '', '/messages')
    threadEl.replaceChildren(h('div', { class: 'msg-empty' }, h('p', {}, 'Select a conversation'), h('p', { class: 'small' }, 'Or start a ', h('button', { class: 'link-button', type: 'button', onclick: openPicker }, 'new message'), '.')))
    renderList(); updateUnread()
    ;(listEl.querySelector(`[data-id="${CSS.escape(previous || '')}"]`) || listEl.querySelector('a'))?.focus()
  }

  // The header: who, presence, View on Unlinked, and the overflow menu.
  function renderThreadHeader() {
    const head = $('msg-thread-head'), conversation = state.conversations.get(state.open)
    // An open options menu is not redrawn under the pointer.
    if (!head || head.querySelector('details[open]')) return
    const peer = conversation && peerOf(conversation), title = conversation ? titleOf(conversation) : 'Conversation'
    const presence = peer ? (peer.isBot ? 'Bot' : peer.presence === 'available' ? 'Active now' : peer.presence === 'away' ? 'Away' : peer.lastSeenAt ? `Seen ${ago(peer.lastSeenAt)} ago` : '') : conversation ? `${conversation.participants.length} people` : ''
    const profile = profiles[state.open]
    const item = (label, onclick, extra = {}) => h('button', { type: 'button', role: 'menuitem', onclick: event => { event.currentTarget.closest('details').open = false; onclick() }, ...extra }, label)
    const menu = conversation ? h('details', { class: 'msg-menu' },
      h('summary', { 'aria-label': 'Conversation options', title: 'Options' }, '⋯'),
      h('div', { class: 'msg-menu-panel', role: 'menu' },
        muted(conversation) ? item('Unmute', () => setMute(null)) : [item('Mute for 1 hour', () => setMute(new Date(Date.now() + 3600000).toISOString())), item('Mute for 8 hours', () => setMute(new Date(Date.now() + 8 * 3600000).toISOString())), item('Mute until I unmute', () => setMute('always'))],
        item('Mark as unread', markUnread),
        h('label', { class: 'msg-menu-check', role: 'menuitemcheckbox', 'aria-checked': String(prefs.enterSends) }, h('input', { type: 'checkbox', checked: prefs.enterSends ? true : null, onchange: event => { prefs.enterSends = event.target.checked; store.set('unlinked.messages.prefs', prefs); renderThreadHeader(); updateComposerHint() } }), 'Enter sends (Shift+Enter for a new line)'),
        h('a', { role: 'menuitem', href: 'https://chat.ideaflow.app/app/', target: '_blank', rel: 'noopener noreferrer' }, 'Open in OpenChat ↗'))) : null
    head.replaceChildren(...[
      h('button', { class: 'msg-back', type: 'button', 'aria-label': 'Back to conversations', onclick: () => closeConversation() }, '←'),
      avatar(title, peer?.id || state.open, peer?.presence),
      h('div', { class: 'msg-thread-who' }, h('h2', {}, title), presence ? h('span', { class: 'small' }, presence) : null),
      profile ? h('a', { class: 'msg-head-link small', href: `/people/${encodeURIComponent(profile)}` }, 'View on Unlinked') : null,
      menu].filter(Boolean))
  }
  async function setMute(mutedUntil) {
    const conversation = state.conversations.get(state.open)
    if (!conversation) return
    try { const value = await api(`/conversations/${encodeURIComponent(conversation.id)}/mute`, { mutedUntil }); conversation.mutedUntil = value.mutedUntil; announce(value.mutedUntil ? 'Muted' : 'Unmuted') }
    catch { announce('Could not change mute. Try again.') }
    renderList(); renderThreadHeader()
  }
  function markUnread() { const id = state.open; if (!id) return; state.markedUnread.add(id); closeConversation(); announce('Marked as unread') }

  // Your last message's state: Sending… / Sent / Seen / Not sent.
  function ownStatus(message, conversation) {
    if (message.pending === 'failed') return null
    if (message.pending) return 'Sending…'
    const reads = state.readMaps.get(conversation.id) || {}
    const seen = others(conversation).some(person => reads[person.id] && reads[person.id] >= message.createdAt)
    return seen ? 'Seen' : 'Sent'
  }

  function messageActions(message, own) {
    if (message.deletedAt || message.pending) return null
    const act = (label, symbol, onclick) => h('button', { type: 'button', class: 'msg-act', 'aria-label': label, title: label, onclick }, symbol)
    return h('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': 'Message actions' },
      act('Add reaction', '☺', event => openReactionPicker(message, event.currentTarget)),
      act('Reply', '↩', () => startReply(message)),
      message.content ? act('Copy text', '⧉', () => { navigator.clipboard?.writeText(message.content).then(() => announce('Copied'), () => announce('Copy failed')) }) : null,
      own && message.messageType === 'text' ? act('Edit', '✎', () => startEdit(message)) : null,
      own ? act('Delete', '🗑', () => removeMessage(message)) : null)
  }

  function messageNode(message, { own, grouped, group, status }) {
    const editing = state.editing === message.id
    const bubble = editing ? editBox(message) : h('div', { class: `msg-bubble${message.deletedAt ? ' deleted' : ''}`, title: time(message.createdAt) },
      message.replyTo && !message.deletedAt ? h('button', { type: 'button', class: 'msg-quote', onclick: () => jumpTo(message.replyTo.id) }, h('b', {}, message.replyTo.senderId === state.me ? 'You' : message.replyTo.senderName || 'Message'), ' ', message.replyTo.content) : null,
      message.deletedAt ? 'Message deleted' : linkify(message.content),
      message.attachments?.length && !message.deletedAt ? h('span', { class: 'msg-attachment' }, `📎 ${message.attachments.length === 1 ? (message.attachments[0].name || 'Attachment') : `${message.attachments.length} attachments`} · open in OpenChat`) : null,
      message.editedAt && !message.deletedAt ? h('span', { class: 'msg-edited' }, ' (edited)') : null)
    return h('div', { class: `msg-row${own ? ' own' : ''}${grouped ? ' grouped' : ''}`, id: `m-${message.id}`, 'data-id': message.id },
      !own && group && !grouped ? h('span', { class: 'msg-sender' }, message.sender?.name || 'Someone') : null,
      h('div', { class: 'msg-line' }, bubble, editing ? null : messageActions(message, own)),
      ...(message.deletedAt ? [] : message.linkPreviews || []).map(preview => h('a', { class: 'msg-preview', href: preview.url, target: '_blank', rel: 'noopener noreferrer' }, h('b', {}, preview.title || preview.url), preview.description ? h('span', {}, preview.description) : null, h('span', { class: 'small' }, preview.siteName || new URL(preview.url).hostname))),
      message.reactions?.length && !message.deletedAt ? h('div', { class: 'msg-reactions' }, message.reactions.map(reaction => h('button', { type: 'button', class: `msg-reaction${reaction.byMe ? ' mine' : ''}`, 'aria-pressed': String(Boolean(reaction.byMe)), 'aria-label': `${reaction.emoji} ${reaction.count}${reaction.byMe ? ', including you' : ''}`, onclick: () => react(message, reaction.emoji, !reaction.byMe) }, reaction.emoji, ' ', reaction.count))) : null,
      message.pending === 'failed' ? h('span', { class: 'msg-meta failed' }, 'Not sent · ', h('button', { class: 'link-button', type: 'button', onclick: () => retry(message) }, 'Retry')) : status ? h('span', { class: 'msg-meta' }, status) : null)
  }

  function renderMessages({ scroll } = {}) {
    const log = $('msg-log'), thread = state.threads.get(state.open), conversation = state.conversations.get(state.open)
    if (!log || !thread || !conversation) return
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
    const anchor = scroll === 'anchor' ? { height: log.scrollHeight, top: log.scrollTop } : null
    const focused = document.activeElement && log.contains(document.activeElement) ? { id: document.activeElement.closest('.msg-row')?.dataset.id, label: document.activeElement.getAttribute('aria-label') } : null
    const group = conversation.type !== 'direct'
    const nodes = []
    if (thread.hasMore) nodes.push(h('div', { class: 'msg-more' }, h('button', { class: 'link-button', type: 'button', onclick: loadOlder }, 'Load earlier messages')))
    if (!thread.items.length) nodes.push(h('p', { class: 'msg-loading' }, 'No messages yet. Say hello.'))
    const lastOwn = [...thread.items].reverse().find(message => message.senderId === state.me)
    let previous = null
    for (const message of thread.items) {
      if (!previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString()) nodes.push(h('div', { class: 'msg-day', role: 'separator' }, h('span', {}, dayLabel(message.createdAt))))
      const own = message.senderId === state.me
      const grouped = Boolean(previous && previous.senderId === message.senderId && Date.parse(message.createdAt) - Date.parse(previous.createdAt) < FIVE_MINUTES && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString())
      nodes.push(messageNode(message, { own, grouped, group, status: own && message === lastOwn ? ownStatus(message, conversation) : null }))
      previous = message
    }
    log.replaceChildren(...nodes)
    if (scroll === 'bottom' || (scroll !== 'anchor' && nearBottom)) { log.scrollTop = log.scrollHeight; hideJump() }
    else if (anchor) log.scrollTop = anchor.top + (log.scrollHeight - anchor.height)
    // Keep keyboard focus on the same control across re-renders.
    if (focused?.id) { const row = $(`m-${focused.id}`); (focused.label && row?.querySelector(`[aria-label="${CSS.escape(focused.label)}"]`) || row?.querySelector('textarea'))?.focus({ preventScroll: true }) }
    if (state.editing) $('msg-edit')?.focus({ preventScroll: true })
  }
  const hideJump = () => { state.newBelow = false; const jump = $('msg-jump'); if (jump) jump.hidden = true }
  function jumpTo(id) {
    const row = $(`m-${id}`)
    if (!row) { announce('That message is further back. Load earlier messages to see it.'); return }
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash')
  }

  async function loadOlder() {
    const id = state.open, thread = state.threads.get(id)
    if (!thread || !thread.hasMore || thread.loading || !thread.items.length) return
    thread.loading = true
    try {
      const page = await api(`/conversations/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(thread.items.find(item => !item.pending)?.createdAt || thread.items[0].createdAt)}`)
      const known = new Set(thread.items.map(message => message.id))
      thread.items = [...page.messages.filter(message => !known.has(message.id)), ...thread.items]
      thread.hasMore = page.hasMore
      if (state.open === id) renderMessages({ scroll: 'anchor' })
    } catch { /* The button stays for another try. */ } finally { thread.loading = false }
  }

  // ── Reactions ──────────────────────────────────────────────────────────────
  async function react(message, emoji, active) {
    const before = message.reactions.map(reaction => ({ ...reaction }))
    // Optimistic toggle, then OpenChat's own counts.
    const existing = message.reactions.find(reaction => reaction.emoji === emoji)
    if (active) { if (existing) { existing.count += existing.byMe ? 0 : 1; existing.byMe = true } else message.reactions.push({ emoji, count: 1, byMe: true }) }
    else if (existing?.byMe) { existing.count--; existing.byMe = false; if (!existing.count) message.reactions = message.reactions.filter(reaction => reaction !== existing) }
    renderMessages()
    try { const value = await api(`/messages/${encodeURIComponent(message.id)}/reactions`, { emoji, active }); message.reactions = value.reactions }
    catch { message.reactions = before; announce('Reaction not saved. Try again.') }
    if (state.open === message.conversationId) renderMessages()
  }
  function openReactionPicker(message, anchorButton) {
    document.querySelector('.msg-react-picker')?.remove()
    const close = () => { picker.remove(); document.removeEventListener('click', away, true); anchorButton.focus({ preventScroll: true }) }
    const away = event => { if (!picker.contains(event.target) && event.target !== anchorButton) close() }
    const picker = h('div', { class: 'msg-react-picker', role: 'menu', 'aria-label': 'Add reaction', onkeydown: event => {
      const buttons = [...picker.querySelectorAll('button')], index = buttons.indexOf(document.activeElement)
      if (event.key === 'Escape') { event.preventDefault(); close() }
      else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus() }
    } }, REACTIONS.map(emoji => h('button', { type: 'button', role: 'menuitem', 'aria-label': `React ${emoji}`, onclick: () => { close(); const mine = message.reactions.find(reaction => reaction.emoji === emoji)?.byMe; react(message, emoji, !mine) } }, emoji)))
    anchorButton.closest('.msg-line').append(picker)
    picker.querySelector('button').focus()
    setTimeout(() => document.addEventListener('click', away, true))
  }

  // ── Reply, edit, delete ───────────────────────────────────────────────────
  function startReply(message) {
    state.replyTo = { id: message.id, senderName: message.senderId === state.me ? 'You' : message.sender?.name || 'Message', content: message.content.slice(0, 200) }
    state.editing = null
    renderReply(); $('msg-input')?.focus()
  }
  function renderReply() {
    const slot = $('msg-reply')
    if (!slot) return
    slot.replaceChildren(...(state.replyTo ? [h('div', { class: 'msg-reply-card' }, h('span', {}, h('b', {}, `Replying to ${state.replyTo.senderName}`), ' ', state.replyTo.content), h('button', { type: 'button', class: 'msg-act', 'aria-label': 'Cancel reply', onclick: () => { state.replyTo = null; renderReply(); $('msg-input')?.focus() } }, '×'))] : []))
  }
  function startEdit(message) {
    state.editing = message.id; state.replyTo = null
    renderReply(); renderMessages()
  }
  function editBox(message) {
    const input = h('textarea', { id: 'msg-edit', class: 'msg-edit', rows: String(Math.min(8, message.content.split('\n').length + 1)), maxlength: '8000', 'aria-label': 'Edit message' })
    input.value = message.content
    const cancel = () => { state.editing = null; renderMessages(); $('msg-input')?.focus({ preventScroll: true }) }
    const save = async () => {
      const content = input.value.trim()
      if (!content || content === message.content) { cancel(); return }
      const before = message.content
      message.content = content; message.editedAt = new Date().toISOString(); state.editing = null; renderMessages()
      try { const value = await api(`/messages/${encodeURIComponent(message.id)}/edit`, { content }); Object.assign(message, value.message, { reactions: message.reactions }) }
      catch { message.content = before; message.editedAt = null; announce('Edit not saved. Try again.') }
      if (state.open === message.conversationId) renderMessages()
      $('msg-input')?.focus({ preventScroll: true })
    }
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel() } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save() } })
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
    return h('div', { class: 'msg-edit-wrap' }, input, h('span', { class: 'small' }, 'Enter to save · Esc to cancel '), h('button', { type: 'button', class: 'link-button', onclick: save }, 'Save'), ' ', h('button', { type: 'button', class: 'link-button', onclick: cancel }, 'Cancel'))
  }
  async function removeMessage(message) {
    if (!confirm('Delete this message for everyone?')) return
    const before = { ...message }
    Object.assign(message, { deletedAt: new Date().toISOString(), content: '' }); renderMessages()
    try { const value = await api(`/messages/${encodeURIComponent(message.id)}/delete`, {}); if (value.message) Object.assign(message, value.message) }
    catch { Object.assign(message, before); announce('Delete failed. Try again.') }
    if (state.open === message.conversationId) renderMessages()
  }

  // ── Composer ───────────────────────────────────────────────────────────────
  let typingActive = false, typingTimer = null
  function stopTyping() { clearTimeout(typingTimer); if (typingActive && state.open) api(`/conversations/${encodeURIComponent(state.open)}/typing`, { active: false }).catch(() => {}); typingActive = false }
  function noteTyping() {
    if (!state.open) return
    if (!typingActive) { typingActive = true; api(`/conversations/${encodeURIComponent(state.open)}/typing`, { active: true }).catch(() => {}) }
    clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 3000)
  }
  function updateComposerHint() { const hint = $('msg-hint'); if (hint) hint.textContent = prefs.enterSends ? 'Enter to send · Shift+Enter for a new line' : 'Ctrl+Enter or ⌘+Enter to send' }
  function composer() {
    const input = h('textarea', { id: 'msg-input', rows: '1', maxlength: '8000', placeholder: 'Write a message…', 'aria-label': 'Message', 'aria-describedby': 'msg-hint', enterkeyhint: prefs.enterSends ? 'send' : 'enter' })
    input.value = drafts[state.open] || ''
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 8 * 24 + 20)}px` }
    let draftTimer = null
    input.addEventListener('input', () => { grow(); clearTimeout(draftTimer); const id = state.open; draftTimer = setTimeout(() => saveDraft(id, input.value.trim()), 400); if (input.value.trim()) noteTyping(); else stopTyping() })
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      const submit = event.key === 'Enter' && (prefs.enterSends ? !event.shiftKey : (event.metaKey || event.ctrlKey))
      if (submit) { event.preventDefault(); form.requestSubmit(); return }
      if (event.key === 'Escape' && (state.replyTo || input.value)) { event.preventDefault(); if (state.replyTo) { state.replyTo = null; renderReply() } else { input.value = ''; grow(); saveDraft(state.open, '') } return }
      // ↑ in an empty composer edits your last message.
      if (event.key === 'ArrowUp' && !input.value) {
        const last = [...(state.threads.get(state.open)?.items || [])].reverse().find(message => message.senderId === state.me && !message.deletedAt && !message.pending && message.messageType === 'text')
        if (last) { event.preventDefault(); startEdit(last) }
      }
    })
    const form = h('form', { class: 'msg-composer', onsubmit: event => {
      event.preventDefault()
      const content = input.value.trim()
      if (!content || !state.threads.has(state.open)) return
      input.value = ''; grow(); saveDraft(state.open, ''); stopTyping()
      const replyToId = state.replyTo?.id; state.replyTo = null; renderReply()
      send(state.open, content, uuid(), replyToId)
    } }, input, h('button', { type: 'submit', class: 'msg-send' }, 'Send'))
    setTimeout(() => { grow(); updateComposerHint() })
    return h('div', { class: 'msg-compose-wrap' }, h('div', { id: 'msg-reply' }), form, h('p', { class: 'msg-hint', id: 'msg-hint' }))
  }

  function upsert(message) {
    const thread = state.threads.get(message.conversationId)
    if (thread) {
      const index = thread.items.findIndex(item => item.id === message.id || (message.clientId && item.clientId === message.clientId))
      if (index >= 0) thread.items[index] = { ...thread.items[index], ...message, pending: undefined }
      else { thread.items.push(message); thread.items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) }
    }
    const conversation = state.conversations.get(message.conversationId)
    if (conversation && (!conversation.lastMessageAt || message.createdAt >= conversation.lastMessageAt)) {
      conversation.lastMessage = { id: message.id, senderId: message.senderId, content: message.content, createdAt: message.createdAt }
      conversation.lastMessageAt = message.createdAt
    }
  }

  async function send(conversationId, content, clientId = uuid(), replyToId = null) {
    const thread = state.threads.get(conversationId)
    const reply = replyToId ? thread?.items.find(item => item.id === replyToId) : null
    const optimistic = { id: `pending-${clientId}`, clientId, conversationId, senderId: state.me, content, createdAt: new Date().toISOString(), reactions: [], pending: 'sending', replyToId, replyTo: reply ? { id: reply.id, senderId: reply.senderId, senderName: reply.sender?.name, content: reply.content.slice(0, 200) } : null }
    if (thread) { thread.items = thread.items.filter(item => item.clientId !== clientId); thread.items.push(optimistic) }
    renderMessages({ scroll: 'bottom' })
    try {
      const value = await api(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content, clientId, ...(replyToId ? { replyToId } : {}) })
      if (value.message) upsert(value.message)
      else if (thread) { const item = thread.items.find(entry => entry.clientId === clientId); if (item) item.pending = undefined }
      const conversation = state.conversations.get(conversationId)
      if (conversation) conversation.unreadCount = 0
      renderList(); if (state.open === conversationId) renderMessages()
    } catch {
      const item = thread?.items.find(entry => entry.clientId === clientId)
      if (item) item.pending = 'failed'
      if (state.open === conversationId) renderMessages()
      announce('Message not sent')
    }
  }
  const retry = message => send(message.conversationId, message.content, message.clientId, message.replyToId)
  // Failed sends are retried once the browser is back online.
  const retryFailed = () => { for (const thread of state.threads.values()) for (const message of thread.items) if (message.pending === 'failed') retry(message) }

  // ── Read state: only while the thread is visible, focused and at the bottom ─
  let readTimer = null
  function maybeMarkRead() {
    clearTimeout(readTimer)
    readTimer = setTimeout(async () => {
      const id = state.open, log = $('msg-log'), conversation = state.conversations.get(id)
      if (!id || !log || !conversation || document.visibilityState !== 'visible' || !document.hasFocus()) return
      if (log.scrollHeight - log.scrollTop - log.clientHeight > 80) return
      hideJump()
      const latest = state.threads.get(id)?.items.filter(item => !item.pending).at(-1)
      if (!conversation.unreadCount && conversation.lastReadAt && latest && conversation.lastReadAt >= latest.createdAt) return
      try {
        const value = await api(`/conversations/${encodeURIComponent(id)}/read`, {})
        conversation.unreadCount = 0; conversation.lastReadAt = value.lastReadAt
        state.readMaps.set(id, { ...(state.readMaps.get(id) || {}), ...value.readMap })
        renderList(); updateUnread(); if (state.open === id) renderMessages()
      } catch { /* Read state catches up on the next visit. */ }
    }, 400)
  }

  // ── New message picker: your connections who are on Unlinked ───────────────
  async function openPicker() {
    let dialog = $('msg-picker')
    if (!dialog) {
      const search = h('input', { type: 'search', id: 'msg-picker-q', placeholder: 'Search your connections', 'aria-label': 'Search your connections on Unlinked', autocomplete: 'off', 'aria-controls': 'msg-picker-list' })
      const list = h('ul', { id: 'msg-picker-list', class: 'msg-picker-list', role: 'listbox', 'aria-label': 'People' })
      const note = h('p', { class: 'small', id: 'msg-picker-note', role: 'status' })
      dialog = h('dialog', { id: 'msg-picker', class: 'msg-picker', 'aria-labelledby': 'msg-picker-title' },
        h('div', { class: 'msg-picker-head' }, h('h2', { id: 'msg-picker-title' }, 'New message'), h('button', { type: 'button', class: 'msg-act', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
        search, note, list)
      document.body.append(dialog)
      search.addEventListener('input', () => renderPicker())
      search.addEventListener('keydown', event => {
        const options = [...list.querySelectorAll('[role=option]')], index = options.findIndex(option => option.getAttribute('aria-selected') === 'true')
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1) + (index < 0 && event.key === 'ArrowUp' ? 1 : 0)) % Math.max(1, options.length)]; options.forEach(option => option.setAttribute('aria-selected', String(option === next))); next?.scrollIntoView({ block: 'nearest' }); if (next) search.setAttribute('aria-activedescendant', next.id) }
        else if (event.key === 'Enter') { event.preventDefault(); (options[index] || options[0])?.click() }
      })
    }
    dialog.showModal()
    $('msg-picker-q').value = ''
    $('msg-picker-q').focus()
    if (!state.people) {
      $('msg-picker-note').textContent = 'Loading your connections…'
      try { state.people = (await api('/people')).people } catch { $('msg-picker-note').textContent = 'Your connections could not load. Close and try again.'; return }
    }
    renderPicker()
  }
  function renderPicker() {
    const q = $('msg-picker-q').value.trim().toLowerCase(), list = $('msg-picker-list'), note = $('msg-picker-note')
    const matches = (state.people || []).filter(person => !q || `${person.name} ${person.headline || ''}`.toLowerCase().includes(q)).slice(0, 50)
    note.textContent = !state.people?.length ? 'None of your connections are on Unlinked yet. Invite them from People.' : !matches.length ? 'No matches' : ''
    list.replaceChildren(...matches.map((person, index) => h('li', { id: `msg-pick-${index}`, role: 'option', 'aria-selected': String(index === 0 && Boolean(q)), tabindex: '-1', class: 'msg-pick', onclick: () => pick(person) },
      avatar(person.name, person.id), h('span', { class: 'msg-item-body' }, h('b', { class: 'msg-item-name' }, person.name), person.headline ? h('span', { class: 'msg-item-preview' }, person.headline) : null))))
  }
  async function pick(person) {
    const note = $('msg-picker-note')
    note.textContent = `Opening ${person.name}…`
    try {
      const value = await api('/conversations', { profile: person.profile })
      if (value.status === 'ready') { $('msg-picker').close(); profiles[value.conversationId] = person.id; store.set('unlinked.messages.profiles', profiles); if (!state.conversations.has(value.conversationId)) await loadConversations(); openConversation(value.conversationId); return }
      note.textContent = value.status === 'unclaimed' ? `${person.name} is not on Unlinked yet.` : `${person.name} is not available for messages right now.`
    } catch { note.textContent = 'That conversation could not open. Try again.' }
  }

  // ── Live updates ───────────────────────────────────────────────────────────
  let refreshTimer = null
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadConversations, 300) }
  function connect() {
    const source = new EventSource(`/messages/api/stream?since=${encodeURIComponent(state.loadedAt)}`)
    state.stream = source
    const on = (name, handler) => source.addEventListener(name, event => { try { handler(JSON.parse(event.data)) } catch { /* Ignore one malformed event. */ } })
    on('ready', value => setStream(value.state))
    on('status', value => setStream(value.state))
    on('message', message => {
      const conversation = state.conversations.get(message.conversationId)
      if (!conversation) { refreshSoon(); return }
      const known = state.threads.get(message.conversationId)?.items.some(item => item.id === message.id || (message.clientId && item.clientId === message.clientId))
      // Count each message once, and only if it is newer than this member's last read.
      const fresh = !known && !counted.has(message.id) && (!conversation.lastReadAt || message.createdAt > conversation.lastReadAt) && (!conversation.lastMessageAt || message.createdAt >= conversation.lastMessageAt)
      counted.add(message.id); if (counted.size > 2000) counted.delete(counted.values().next().value)
      const visible = message.conversationId === state.open && document.visibilityState === 'visible'
      if (fresh && message.senderId !== state.me && !visible) conversation.unreadCount = (conversation.unreadCount || 0) + 1
      state.typing.get(message.conversationId)?.delete(message.senderId)
      upsert(message)
      renderList(); updateUnread()
      if (message.conversationId === state.open) {
        const log = $('msg-log'), below = log && log.scrollHeight - log.scrollTop - log.clientHeight > 80
        renderMessages(); renderTyping()
        if (below && !known && message.senderId !== state.me) { state.newBelow = true; const jump = $('msg-jump'); if (jump) jump.hidden = false }
        maybeMarkRead()
      }
    })
    on('message-updated', message => { const thread = state.threads.get(message.conversationId); const item = thread?.items.find(entry => entry.id === message.id); if (item) { const byMe = new Map(item.reactions.map(reaction => [reaction.emoji, reaction.byMe])); Object.assign(item, message, { reactions: (message.reactions.length ? message.reactions : item.reactions).map(reaction => ({ ...reaction, byMe: Boolean(byMe.get(reaction.emoji)) })) }); if (state.open === message.conversationId && state.editing !== message.id) renderMessages() } const conversation = state.conversations.get(message.conversationId); if (conversation?.lastMessage?.id === message.id) { conversation.lastMessage.content = message.content; renderList() } })
    on('message-changed', value => {
      // A link preview finished: re-read just this thread's latest page.
      if (value.conversationId !== state.open || !state.threads.has(value.conversationId)) return
      api(`/conversations/${encodeURIComponent(value.conversationId)}/messages`).then(page => { const thread = state.threads.get(value.conversationId); if (!thread) return; for (const fresh of page.messages) { const item = thread.items.find(entry => entry.id === fresh.id); if (item) item.linkPreviews = fresh.linkPreviews } if (state.open === value.conversationId) renderMessages() }).catch(() => {})
    })
    on('reactions', value => { const item = state.threads.get(value.conversationId)?.items.find(entry => entry.id === value.messageId); if (!item) return; const mine = new Map(item.reactions.map(reaction => [reaction.emoji, reaction.byMe])); item.reactions = value.reactions.map(reaction => ({ ...reaction, byMe: Boolean(mine.get(reaction.emoji)) })); if (state.open === value.conversationId) renderMessages() })
    on('read', value => { state.readMaps.set(value.conversationId, { ...(state.readMaps.get(value.conversationId) || {}), ...value.readMap }); if (value.userId === state.me) { const conversation = state.conversations.get(value.conversationId); if (conversation) { conversation.unreadCount = 0; conversation.lastReadAt = value.lastReadAt || conversation.lastReadAt; renderList(); updateUnread() } } if (state.open === value.conversationId) renderMessages() })
    on('typing', value => {
      if (value.userId === state.me) return
      let entries = state.typing.get(value.conversationId)
      if (value.active) { if (!entries) state.typing.set(value.conversationId, entries = new Map()); entries.set(value.userId, Date.now() + 6000) } else entries?.delete(value.userId)
      renderTyping(); renderList()
    })
    on('presence', value => { for (const conversation of state.conversations.values()) for (const person of conversation.participants) if (person.id === value.userId) person.presence = value.presence; renderList(); renderThreadHeader() })
    on('conversation', refreshSoon)
    on('resync', () => { state.threads.clear(); loadConversations() })
    on('expired', () => { source.close(); showStatus('Your session ended.', { href: `/login?next=${encodeURIComponent(location.pathname)}`, label: 'Sign in again' }) })
    on('superseded', () => { source.close(); state.stream = null; state.paused = true; setStream('paused') })
    source.addEventListener('open', () => { state.retryMs = 2000 })
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED) { setStream('reconnecting'); return }
      // A non-200 answer (deploy, busy, rate limit) closes an EventSource for good: reopen it with backoff.
      setStream('reconnecting')
      if (state.stream === source) state.stream = null
      clearTimeout(state.retryTimer)
      state.retryTimer = setTimeout(() => { if (!state.stream && !state.paused) { state.loadedAt = new Date().toISOString(); loadConversations().then(() => { if (!state.stream && !state.paused) connect() }) } }, state.retryMs)
      state.retryMs = Math.min(60000, (state.retryMs || 2000) * 2)
    })
  }
  function setStream(value) {
    state.streamState = value
    const pill = $('msg-live')
    if (pill) { pill.hidden = value === 'live' || value === 'polling'; pill.textContent = value === 'paused' ? 'Paused · open in another tab' : value === 'offline' ? 'Offline' : 'Reconnecting…' }
    if (value === 'live' || value === 'polling') { if (statusEl.dataset.offline) { delete statusEl.dataset.offline; showStatus('') } }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  $('msg-new')?.addEventListener('click', openPicker)
  $('msg-unread-first')?.addEventListener('click', () => { state.unreadFirst = !state.unreadFirst; renderList() })
  filterEl?.addEventListener('input', () => { state.filter = filterEl.value.trim().toLowerCase(); renderList() })
  filterEl?.addEventListener('keydown', event => { if (event.key === 'Escape' && filterEl.value) { event.preventDefault(); filterEl.value = ''; state.filter = ''; renderList() } else if (event.key === 'ArrowDown') { event.preventDefault(); listEl.querySelector('a')?.focus() } })
  // Arrow keys move through the conversation list.
  listEl.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const links = [...listEl.querySelectorAll('a.msg-item')], index = links.indexOf(document.activeElement)
    if (index < 0) return
    event.preventDefault()
    links[event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : Math.max(0, Math.min(links.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  })
  document.addEventListener('keydown', event => {
    const typingTarget = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable
    // "/" focuses the filter; Alt+↑/↓ switches conversations; Esc closes the thread on small screens.
    if (event.key === '/' && !typingTarget && !event.metaKey && !event.ctrlKey) { event.preventDefault(); if (state.open && matchMedia('(max-width: 759px)').matches) closeConversation(); filterEl?.focus() }
    else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const ids = sorted().map(conversation => conversation.id), index = ids.indexOf(state.open)
      const next = ids[index < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next && next !== state.open) { event.preventDefault(); openConversation(next) }
    } else if (event.key === 'Escape' && !typingTarget && state.open && !document.querySelector('dialog[open]') && matchMedia('(max-width: 759px)').matches) closeConversation()
  })
  addEventListener('popstate', () => { const match = /^\/messages\/c\/([A-Za-z0-9_-]{1,80})$/.exec(location.pathname); if (match) openConversation(match[1], { push: false }); else closeConversation({ push: false }) })
  addEventListener('focus', maybeMarkRead)
  const resume = () => { if (!state.paused) return; state.paused = false; state.loadedAt = new Date().toISOString(); loadConversations().then(() => { if (!state.stream) connect() }) }
  addEventListener('focus', resume)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { resume(); maybeMarkRead(); updateUnread() } else stopTyping() })
  threadEl.addEventListener('scroll', event => { if (event.target.id !== 'msg-log') return; if (event.target.scrollTop < 120) loadOlder(); maybeMarkRead() }, true)
  // Touch: tapping a bubble shows its actions (no hover on phones).
  threadEl.addEventListener('click', event => {
    const bubble = event.target.closest?.('.msg-bubble')
    if (!bubble || event.target.closest('a,button') || !matchMedia('(hover: none)').matches) return
    const row = bubble.closest('.msg-row')
    for (const other of threadEl.querySelectorAll('.msg-row.show-actions')) if (other !== row) other.classList.remove('show-actions')
    row.classList.toggle('show-actions')
  })
  // Pages may be kept in the back/forward cache: close the stream when hidden
  // and catch up (list, open thread, stream) when the page comes back.
  addEventListener('pagehide', () => { stopTyping(); if (state.open) saveDraft(state.open, $('msg-input')?.value.trim() || ''); state.stream?.close(); state.stream = null })
  addEventListener('pageshow', event => { if (!event.persisted) return; state.threads.clear(); state.loadedAt = new Date().toISOString(); loadConversations().then(() => { if (!state.stream) connect() }) })
  addEventListener('offline', () => { statusEl.dataset.offline = '1'; showStatus('You are offline. Messages will send when you reconnect.') })
  addEventListener('online', () => { delete statusEl.dataset.offline; showStatus(''); refreshSoon(); retryFailed() })

  if (config.conversationId) { state.open = config.conversationId; root.dataset.open = config.conversationId; threadShell() }
  loadConversations().then(() => connect())
}

/** The page script: the client plus its per-page configuration (CSRF token, open conversation). */
export function messagesScript({ csrf, conversationId = null, reactions }) {
  const config = JSON.stringify({ csrf, conversationId, reactions }).replace(/</g, '\\u003c')
  return `(${messagesClient.toString()})(${config});`
}
