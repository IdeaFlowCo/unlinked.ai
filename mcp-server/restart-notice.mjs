import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Public, read-only lifecycle messages only. No identity, maintenance controls,
// credentials or application data are exposed by this stream.
export function createRestartNotice({ origin, maxClients = 2000, graceMs = 5000 } = {}) {
  const instance = randomUUID(), clients = new Set()
  let restartingAt = null, pending
  const send = response => response.write(`data: ${JSON.stringify({ instance, restartingAt })}\n\n`)
  return {
    handle(request, response) {
      if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403).end(); return }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
      if (request.method === 'HEAD') { response.writeHead(200, { 'Cache-Control': 'no-store' }).end(); return }
      if (clients.size >= maxClients) { response.writeHead(503, { 'Retry-After': '15' }).end(); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
      response.write('retry: 2000\n\n'); send(response); clients.add(response)
      const heartbeat = setInterval(() => { if (!response.write(': heartbeat\n\n')) response.destroy() }, 20000)
      heartbeat.unref?.()
      response.once('close', () => { clearInterval(heartbeat); clients.delete(response) })
    },
    announce() {
      if (!pending) {
        restartingAt = Date.now() + graceMs
        for (const response of clients) send(response)
        pending = delay(graceMs)
      }
      return pending
    },
    close() { for (const response of clients) response.end(); clients.clear() },
  }
}

// A persistent, polite status banner. Never reload a page or discard a draft.
// Errors without a planned notice remain silent: offline is not proof of restart.
export function restartNoticeClient() {
  if (!globalThis.EventSource || globalThis.__unlinkedRestartNotice) return
  globalThis.__unlinkedRestartNotice = true
  let stream, instance, restarting = false, banner, recoveryTimer, retryTimer, active = true
  const show = message => {
    if (!banner) {
      banner = document.createElement('div')
      banner.id = 'unlinked-restart-notice'
      banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite')
      banner.style.cssText = 'position:fixed;z-index:2147483000;bottom:calc(16px + env(safe-area-inset-bottom,0px));left:16px;right:16px;width:fit-content;max-width:calc(100% - 32px);box-sizing:border-box;margin:auto;padding:12px 16px;border:1px solid #4349c4;border-radius:8px;background:#f5f6fc;color:#16181d;font:500 14px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px #16181d14;pointer-events:none'
      document.documentElement.append(banner)
    }
    banner.textContent = message
  }
  const connect = () => {
    if (stream || !active) return
    const source = new EventSource('/api/runtime-events')
    stream = source
    // A proxy can return 502/503 while the process starts. Some browsers close
    // EventSource permanently for those responses, so explicitly retry as well.
    source.onerror = () => {
      if (stream !== source) return
      source.close(); stream = null
      clearTimeout(retryTimer)
      if (active) retryTimer = setTimeout(connect, 2000 + Math.random() * 1000)
    }
    source.onmessage = event => {
      let state
      try { state = JSON.parse(event.data) } catch { return }
      if (typeof state.instance !== 'string') return
      if (Number.isFinite(state.restartingAt)) {
        clearTimeout(recoveryTimer); restarting = true
        show(Date.now() < state.restartingAt ? 'Unlinked is restarting in a few seconds. You may notice a brief interruption.' : 'Unlinked is restarting. Reconnecting automatically…')
        setTimeout(() => { if (restarting) show('Unlinked is restarting. Reconnecting automatically…') }, Math.max(0, state.restartingAt - Date.now()))
      } else if (restarting && instance && instance !== state.instance) {
        restarting = false; show('Unlinked is back. You can continue.')
        recoveryTimer = setTimeout(() => { banner?.remove(); banner = null }, 8000)
      }
      instance = state.instance
    }
  }
  addEventListener('pagehide', () => { active = false; clearTimeout(retryTimer); stream?.close(); stream = null })
  addEventListener('pageshow', () => { active = true; connect() })
  connect()
}
export const RESTART_NOTICE_SCRIPT = `;(${restartNoticeClient.toString()})();`
