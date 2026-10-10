// Progressive enhancement only: forms still POST and redirect without JavaScript.
// Served as a fixed asset authorized by the existing per-response nonce.
export function installConnectionFeedback() {
  const pending = new Map()
  document.addEventListener('submit', event => {
    const form = event.target
    if (event.defaultPrevented || !form.matches('form.connect[action="/connections/request"]')) return
    if (pending.has(form)) { event.preventDefault(); return }
    const buttons = Array.from(form.elements).filter(el => el.type === 'submit')
    const restore = buttons.map(el => ({ el, disabled: el.disabled, content: el.innerHTML }))
    const status = document.createElement('span')
    status.className = 'small'; status.setAttribute('role', 'status')
    status.textContent = 'Sending your connection request…'
    form.append(status); form.setAttribute('aria-busy', 'true')
    pending.set(form, { restore, status })
    // These buttons have no name/value; disabling them does not change the POST.
    for (const button of buttons) { button.disabled = true; button.textContent = 'Sending…' }
  })
  window.addEventListener('pageshow', () => {
    // Back/forward cache can restore the submitting DOM after navigation.
    for (const [form, { restore, status }] of pending) {
      for (const { el, disabled, content } of restore) { el.disabled = disabled; el.innerHTML = content }
      status.remove(); form.removeAttribute('aria-busy')
    }
    pending.clear()
  })
  const links = [
    { key: 'network', href: '/invitations', label: 'My Network', suffix: 'pending' },
    { key: 'notifications', href: '/notifications', label: 'Notifications', suffix: 'new' },
  ].map(value => ({ ...value, node: document.querySelector('a.nav-ico[href="' + value.href + '"]') }))
  const messagesLink = document.querySelector('a[data-nav-messages]')
  if (!links.some(value => value.node) && !messagesLink) return
  let busy = false, stopped = false, last = 0
  async function refresh() {
    if (document.hidden || busy || stopped || Date.now() - last < 2000) return
    busy = true; last = Date.now()
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch('/api/nav-alerts', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (response.status === 401) { stopped = true; return }
      if (!response.ok) return
      const counts = await response.json()
      for (const { node, key, label, suffix } of links) {
        if (!node || !Number.isSafeInteger(counts[key]) || counts[key] < 0) continue
        const count = counts[key], text = count > 99 ? '99+' : String(count)
        node.setAttribute('aria-label', label + (count ? ', ' + text + ' ' + suffix : ''))
        let badge = node.querySelector('.badge')
        if (count) {
          if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; badge.setAttribute('aria-hidden', 'true'); node.append(badge) }
          badge.textContent = text
        } else badge?.remove()
      }
      // The Messages count, unless the Messages page or an open dock already keeps it live.
      const dock = document.getElementById('msg-dock')
      const live = (document.getElementById('msg-app') && !dock) || (dock?.dataset.expanded === 'true' && matchMedia('(min-width: 1024px)').matches && ['live', 'polling'].includes(dock.dataset.stream))
      if (messagesLink && !live && Number.isSafeInteger(counts.messages) && counts.messages >= 0) {
        const text = counts.messages > 99 ? '99+' : String(counts.messages)
        messagesLink.querySelector('.nav-count')?.remove()
        if (counts.messages) { const count = document.createElement('span'); count.className = 'nav-count'; count.setAttribute('aria-label', text + ' unread'); count.textContent = text; messagesLink.append(count) }
        const bar = document.getElementById('msg-dock-count')
        if (bar) { bar.textContent = counts.messages ? text : ''; bar.hidden = !counts.messages }
      }
    } catch { /* Keep the last confirmed counts until the next successful read. */ }
    finally { clearTimeout(timeout); busy = false }
  }
  setInterval(refresh, 15000)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
}
export const CONNECTION_FEEDBACK_SCRIPT = `;(${installConnectionFeedback.toString()})();`
