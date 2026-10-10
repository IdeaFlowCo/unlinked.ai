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
  const counted = new Set()
  const state = { me: null, conversations: new Map(), threads: new Map(), open: null, loadedAt: new Date().toISOString(), readMaps: new Map(), stream: null, streamState: 'connecting', filter: '', retryMs: 2000, retryTimer: null, paused: false }
  const FIVE_MINUTES = 5 * 60000

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
  const sorted = () => [...state.conversations.values()].sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')))

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
    if (!state.conversations.size) { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'No conversations yet. ', h('a', { href: '/network' }, 'Message someone from People →'))); return }
    if (!items.length) { listEl.replaceChildren(h('li', { class: 'msg-list-empty' }, 'No results')); return }
    listEl.replaceChildren(...items.map(conversation => {
      const peer = peerOf(conversation), title = titleOf(conversation), last = conversation.lastMessage
      const preview = last ? `${last.senderId === state.me ? 'You: ' : ''}${last.content || 'Attachment'}` : 'No messages yet'
      const unread = conversation.unreadCount > 0 && conversation.id !== state.open
      return h('li', {},
        h('a', { class: `msg-item${conversation.id === state.open ? ' active' : ''}${unread ? ' unread' : ''}`, href: `/messages/c/${encodeURIComponent(conversation.id)}`, 'aria-current': conversation.id === state.open ? 'page' : null, onclick: event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openConversation(conversation.id) } },
          avatar(title, peer?.id || conversation.id, peer?.presence),
          h('span', { class: 'msg-item-body' },
            h('span', { class: 'msg-item-top' }, h('b', { class: 'msg-item-name' }, title), peer?.isBot || conversation.containsBot ? h('span', { class: 'msg-tag' }, 'Bot') : null, muted(conversation) ? h('span', { class: 'msg-muted', title: 'Muted', 'aria-label': 'Muted' }, '🔕') : null, h('span', { class: 'msg-item-time' }, ago(conversation.lastMessageAt))),
            h('span', { class: 'msg-item-preview' }, preview)),
          unread ? h('span', { class: 'msg-pill', 'aria-label': `${conversation.unreadCount} unread` }, conversation.unreadCount > 99 ? '99+' : conversation.unreadCount) : null))
    }))
  }

  function updateUnread() {
    const total = [...state.conversations.values()].reduce((sum, conversation) => sum + (conversation.id === state.open && document.visibilityState === 'visible' ? 0 : conversation.unreadCount || 0), 0)
    document.title = `${total ? `(${total > 99 ? '99+' : total}) ` : ''}Messages · Unlinked`
    const nav = document.querySelector('[data-nav-messages]')
    if (nav) {
      nav.querySelector('.nav-count')?.remove()
      if (total) nav.append(h('span', { class: 'nav-count', 'aria-label': `${total} unread` }, total > 99 ? '99+' : total))
    }
  }

  // ── Thread ─────────────────────────────────────────────────────────────────
  async function openConversation(id, { push = true } = {}) {
    state.open = id
    root.dataset.open = id
    if (push && location.pathname !== `/messages/c/${id}`) history.pushState({ id }, '', `/messages/c/${encodeURIComponent(id)}`)
    renderList()
    const conversation = state.conversations.get(id)
    threadEl.replaceChildren(h('div', { class: 'msg-thread-head', id: 'msg-thread-head' }), h('div', { class: 'msg-log', id: 'msg-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages', tabindex: '0' }, h('p', { class: 'msg-loading' }, 'Loading…')), composer())
    renderThreadHeader()
    if (!conversation && state.me) { $('msg-log').replaceChildren(h('p', { class: 'msg-loading' }, 'This conversation is not available.')); return }
    api(`/conversations/${encodeURIComponent(id)}/focus`, {}).catch(() => {})
    try {
      if (!state.threads.has(id)) { const page = await api(`/conversations/${encodeURIComponent(id)}/messages`); state.threads.set(id, { items: page.messages, hasMore: page.hasMore }) }
      if (state.open !== id) return
      renderMessages({ scroll: 'bottom' })
      $('msg-input')?.focus({ preventScroll: true })
      maybeMarkRead()
    } catch (error) {
      if (state.open === id && error.message !== 'signed_out') $('msg-log').replaceChildren(h('p', { class: 'msg-loading' }, 'Messages could not load. ', h('button', { class: 'link-button', type: 'button', onclick: () => openConversation(id, { push: false }) }, 'Try again')))
    }
  }

  function closeConversation({ push = true } = {}) {
    state.open = null
    delete root.dataset.open
    if (push) history.pushState({}, '', '/messages')
    threadEl.replaceChildren(h('div', { class: 'msg-empty' }, h('p', {}, 'Select a conversation'), h('p', { class: 'small' }, 'Or message someone from ', h('a', { href: '/network' }, 'People'), '.')))
    renderList(); updateUnread()
    listEl.querySelector('a')?.focus()
  }

  function renderThreadHeader() {
    const head = $('msg-thread-head'), conversation = state.conversations.get(state.open)
    if (!head) return
    const peer = conversation && peerOf(conversation), title = conversation ? titleOf(conversation) : 'Conversation'
    const presence = peer ? (peer.presence === 'available' ? 'Active now' : peer.presence === 'away' ? 'Away' : peer.lastSeenAt ? `Seen ${ago(peer.lastSeenAt)} ago` : '') : conversation ? `${conversation.participants.length} people` : ''
    head.replaceChildren(
      h('button', { class: 'msg-back', type: 'button', 'aria-label': 'Back to conversations', onclick: () => closeConversation() }, '←'),
      avatar(title, peer?.id || state.open, peer?.presence),
      h('div', { class: 'msg-thread-who' }, h('h2', {}, title), presence ? h('span', { class: 'small' }, presence) : null),
      h('a', { class: 'msg-head-link small', href: 'https://chat.ideaflow.app/app/', target: '_blank', rel: 'noopener noreferrer' }, 'Open in OpenChat ↗'))
  }

  // Your last message's state: Sending… / Sent / Seen / Not sent.
  function ownStatus(message, conversation) {
    if (message.pending === 'failed') return null
    if (message.pending) return 'Sending…'
    const reads = state.readMaps.get(conversation.id) || {}
    const seen = others(conversation).some(person => reads[person.id] && reads[person.id] >= message.createdAt)
    return seen ? 'Seen' : 'Sent'
  }

  function renderMessages({ scroll } = {}) {
    const log = $('msg-log'), thread = state.threads.get(state.open), conversation = state.conversations.get(state.open)
    if (!log || !thread || !conversation) return
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
    const anchor = scroll === 'anchor' ? { height: log.scrollHeight, top: log.scrollTop } : null
    const group = conversation.type !== 'direct'
    const nodes = []
    if (thread.hasMore) nodes.push(h('div', { class: 'msg-more' }, h('button', { class: 'link-button', type: 'button', onclick: loadOlder }, 'Load earlier messages')))
    if (!thread.items.length) nodes.push(h('p', { class: 'msg-loading' }, 'No messages yet. Say hello.'))
    const lastOwn = [...thread.items].reverse().find(message => message.senderId === state.me)
    let previous = null
    for (const message of thread.items) {
      if (!previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString()) nodes.push(h('div', { class: 'msg-day', role: 'separator' }, h('span', {}, dayLabel(message.createdAt))))
      const own = message.senderId === state.me
      const grouped = previous && previous.senderId === message.senderId && Date.parse(message.createdAt) - Date.parse(previous.createdAt) < FIVE_MINUTES && new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString()
      const status = own && message === lastOwn ? ownStatus(message, conversation) : null
      nodes.push(h('div', { class: `msg-row${own ? ' own' : ''}${grouped ? ' grouped' : ''}`, id: `m-${message.id}`, 'data-id': message.id },
        !own && group && !grouped ? h('span', { class: 'msg-sender' }, message.sender?.name || 'Someone') : null,
        h('div', { class: `msg-bubble${message.deletedAt ? ' deleted' : ''}`, title: time(message.createdAt) },
          message.replyTo ? h('a', { class: 'msg-quote', href: `#m-${message.replyTo.id}` }, h('b', {}, message.replyTo.senderName || 'Message'), ' ', message.replyTo.content) : null,
          message.deletedAt ? 'Message deleted' : linkify(message.content),
          message.attachments?.length && !message.deletedAt ? h('span', { class: 'msg-attachment' }, `📎 ${message.attachments.length === 1 ? (message.attachments[0].name || 'Attachment') : `${message.attachments.length} attachments`} · open in OpenChat`) : null,
          message.editedAt && !message.deletedAt ? h('span', { class: 'msg-edited' }, ' (edited)') : null),
        ...(message.linkPreviews || []).map(preview => h('a', { class: 'msg-preview', href: preview.url, target: '_blank', rel: 'noopener noreferrer' }, h('b', {}, preview.title || preview.url), preview.description ? h('span', {}, preview.description) : null, h('span', { class: 'small' }, preview.siteName || new URL(preview.url).hostname))),
        message.reactions?.length ? h('div', { class: 'msg-reactions' }, message.reactions.map(reaction => h('span', { class: `msg-reaction${reaction.byMe ? ' mine' : ''}` }, reaction.emoji, ' ', reaction.count))) : null,
        message.pending === 'failed' ? h('span', { class: 'msg-meta failed' }, 'Not sent · ', h('button', { class: 'link-button', type: 'button', onclick: () => retry(message) }, 'Retry')) : status ? h('span', { class: 'msg-meta' }, status) : null))
      previous = message
    }
    log.replaceChildren(...nodes)
    if (scroll === 'bottom' || (scroll !== 'anchor' && nearBottom)) log.scrollTop = log.scrollHeight
    else if (anchor) log.scrollTop = anchor.top + (log.scrollHeight - anchor.height)
  }

  async function loadOlder() {
    const id = state.open, thread = state.threads.get(id)
    if (!thread || !thread.hasMore || thread.loading || !thread.items.length) return
    thread.loading = true
    try {
      const page = await api(`/conversations/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(thread.items[0].createdAt)}`)
      const known = new Set(thread.items.map(message => message.id))
      thread.items = [...page.messages.filter(message => !known.has(message.id)), ...thread.items]
      thread.hasMore = page.hasMore
      if (state.open === id) renderMessages({ scroll: 'anchor' })
    } catch { /* The button stays for another try. */ } finally { thread.loading = false }
  }

  // ── Composer ───────────────────────────────────────────────────────────────
  function composer() {
    const input = h('textarea', { id: 'msg-input', rows: '1', maxlength: '8000', placeholder: 'Write a message…', 'aria-label': 'Message', enterkeyhint: 'send' })
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 8 * 24 + 20)}px` }
    input.addEventListener('input', grow)
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() } })
    const form = h('form', { class: 'msg-composer', onsubmit: event => { event.preventDefault(); const content = input.value.trim(); if (!content || !state.threads.has(state.open)) return; input.value = ''; grow(); send(state.open, content) } },
      input, h('button', { type: 'submit', class: 'msg-send' }, 'Send'))
    return form
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

  async function send(conversationId, content, clientId = uuid()) {
    const thread = state.threads.get(conversationId)
    const optimistic = { id: `pending-${clientId}`, clientId, conversationId, senderId: state.me, content, createdAt: new Date().toISOString(), reactions: [], pending: 'sending' }
    if (thread) { thread.items = thread.items.filter(item => item.clientId !== clientId); thread.items.push(optimistic) }
    renderMessages({ scroll: 'bottom' })
    try {
      const value = await api(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content, clientId })
      if (value.message) upsert(value.message)
      else if (thread) { const item = thread.items.find(entry => entry.clientId === clientId); if (item) item.pending = undefined }
      const conversation = state.conversations.get(conversationId)
      if (conversation) conversation.unreadCount = 0
      renderList(); if (state.open === conversationId) renderMessages()
    } catch {
      const item = thread?.items.find(entry => entry.clientId === clientId)
      if (item) item.pending = 'failed'
      if (state.open === conversationId) renderMessages()
    }
  }
  const retry = message => send(message.conversationId, message.content, message.clientId)

  // ── Read state: only while the thread is visible, focused and at the bottom ─
  let readTimer = null
  function maybeMarkRead() {
    clearTimeout(readTimer)
    readTimer = setTimeout(async () => {
      const id = state.open, log = $('msg-log'), conversation = state.conversations.get(id)
      if (!id || !log || !conversation || document.visibilityState !== 'visible' || !document.hasFocus()) return
      if (log.scrollHeight - log.scrollTop - log.clientHeight > 80) return
      const latest = state.threads.get(id)?.items.at(-1)
      if (!conversation.unreadCount && conversation.lastReadAt && latest && conversation.lastReadAt >= latest.createdAt) return
      try {
        const value = await api(`/conversations/${encodeURIComponent(id)}/read`, {})
        conversation.unreadCount = 0; conversation.lastReadAt = value.lastReadAt
        state.readMaps.set(id, { ...(state.readMaps.get(id) || {}), ...value.readMap })
        renderList(); updateUnread(); if (state.open === id) renderMessages()
      } catch { /* Read state catches up on the next visit. */ }
    }, 400)
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
      if (fresh && message.senderId !== state.me && !(message.conversationId === state.open && document.visibilityState === 'visible')) conversation.unreadCount = (conversation.unreadCount || 0) + 1
      upsert(message)
      renderList(); updateUnread()
      if (message.conversationId === state.open) { renderMessages(); maybeMarkRead() }
    })
    on('message-updated', message => { const thread = state.threads.get(message.conversationId); const item = thread?.items.find(entry => entry.id === message.id); if (item) { const byMe = new Map(item.reactions.map(reaction => [reaction.emoji, reaction.byMe])); Object.assign(item, message, { reactions: (message.reactions.length ? message.reactions : item.reactions).map(reaction => ({ ...reaction, byMe: Boolean(byMe.get(reaction.emoji)) })) }); if (state.open === message.conversationId) renderMessages() } })
    on('message-changed', () => {})
    on('reactions', value => { const item = state.threads.get(value.conversationId)?.items.find(entry => entry.id === value.messageId); if (!item) return; const mine = new Map(item.reactions.map(reaction => [reaction.emoji, reaction.byMe])); item.reactions = value.reactions.map(reaction => ({ ...reaction, byMe: Boolean(mine.get(reaction.emoji)) })); if (state.open === value.conversationId) renderMessages() })
    on('read', value => { state.readMaps.set(value.conversationId, { ...(state.readMaps.get(value.conversationId) || {}), ...value.readMap }); if (value.userId === state.me) { const conversation = state.conversations.get(value.conversationId); if (conversation) { conversation.unreadCount = 0; renderList(); updateUnread() } } if (state.open === value.conversationId) renderMessages() })
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
  filterEl?.addEventListener('input', () => { state.filter = filterEl.value.trim().toLowerCase(); renderList() })
  addEventListener('popstate', () => { const match = /^\/messages\/c\/([A-Za-z0-9_-]{1,80})$/.exec(location.pathname); if (match) openConversation(match[1], { push: false }); else closeConversation({ push: false }) })
  addEventListener('focus', maybeMarkRead)
  const resume = () => { if (!state.paused) return; state.paused = false; state.loadedAt = new Date().toISOString(); loadConversations().then(() => { if (!state.stream) connect() }) }
  addEventListener('focus', resume)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { resume(); maybeMarkRead(); updateUnread() } })
  threadEl.addEventListener('scroll', event => { if (event.target.id !== 'msg-log') return; if (event.target.scrollTop < 120) loadOlder(); maybeMarkRead() }, true)
  // Pages may be kept in the back/forward cache: close the stream when hidden
  // and catch up (list, open thread, stream) when the page comes back.
  addEventListener('pagehide', () => { state.stream?.close(); state.stream = null })
  addEventListener('pageshow', event => { if (!event.persisted) return; state.threads.clear(); state.loadedAt = new Date().toISOString(); loadConversations().then(() => { if (!state.stream) connect() }) })
  addEventListener('offline', () => { statusEl.dataset.offline = '1'; showStatus('You are offline. Messages will send when you reconnect.') })
  addEventListener('online', () => { delete statusEl.dataset.offline; showStatus(''); refreshSoon() })

  if (config.conversationId) { state.open = config.conversationId; root.dataset.open = config.conversationId; threadEl.replaceChildren(h('div', { class: 'msg-thread-head', id: 'msg-thread-head' }), h('div', { class: 'msg-log', id: 'msg-log', role: 'log', 'aria-live': 'polite', tabindex: '0' }, h('p', { class: 'msg-loading' }, 'Loading…')), composer()) }
  loadConversations().then(() => connect())
}

/** The page script: the client plus its per-page configuration (CSRF token, open conversation). */
export function messagesScript({ csrf, conversationId = null, entry = null }) {
  const config = JSON.stringify({ csrf, conversationId, entry: entry ? entry.status : null }).replace(/</g, '\\u003c')
  return `(${messagesClient.toString()})(${config});`
}
