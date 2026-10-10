// A minimal Socket.IO v4 client over the runtime's global WebSocket, for the
// server-side messaging bridge (docs/openchat-message.md). It speaks only what
// the bridge needs: Engine.IO v4 text framing, the default namespace with
// `auth: { token }`, ping/pong, and plain JSON events. No binary packets, no
// acknowledgements, no HTTP long-polling transport.
//
// Engine.IO packets: 0 open, 1 close, 2 ping, 3 pong, 4 message.
// Socket.IO packets (inside 4): 0 CONNECT, 1 DISCONNECT, 2 EVENT, 4 CONNECT_ERROR.

export const OPENCHAT_SOCKET_URL = 'wss://chat.ideaflow.app/socket.io/?EIO=4&transport=websocket'
const MAX_FRAME = 1_000_000

// Parse one Socket.IO EVENT payload (`2` + optional ack id + JSON array).
export function parseEventPacket(text) {
  if (typeof text !== 'string' || text[0] !== '2') return null
  let index = 1
  // Namespaced packets ("2/ns,...") are not used by OpenChat's default namespace.
  if (text[index] === '/') return null
  while (index < text.length && text[index] >= '0' && text[index] <= '9') index++
  let value
  try { value = JSON.parse(text.slice(index)) } catch { return null }
  if (!Array.isArray(value) || typeof value[0] !== 'string') return null
  return { event: value[0], args: value.slice(1) }
}

export const encodeEvent = (event, ...args) => `42${JSON.stringify([event, ...args])}`

/**
 * Open one authenticated socket. Resolves once the namespace CONNECT succeeds;
 * rejects on CONNECT_ERROR (e.g. an expired token), a close or the timeout.
 * After that, `onEvent(event, ...args)` gets server events and `onClose(reason)`
 * is called exactly once when the connection ends for any reason.
 */
export function connectOpenChatSocket({ token, url = OPENCHAT_SOCKET_URL, WebSocketImpl = globalThis.WebSocket, onEvent = () => {}, onClose = () => {}, timeoutMs = 8000 }) {
  if (typeof token !== 'string' || !token) return Promise.reject(Error('socket_token_required'))
  if (typeof WebSocketImpl !== 'function') return Promise.reject(Error('socket_unavailable'))
  return new Promise((resolve, reject) => {
    let socket, settled = false, closed = false, pingTimer = null, pingTimeout = 45000
    const handle = {
      emit(event, ...args) { if (!closed && socket.readyState === 1) socket.send(encodeEvent(event, ...args)) },
      close() { finish('client_close') },
      get open() { return !closed },
    }
    // Engine.IO v4: the server pings; if no ping arrives within interval+timeout, the link is dead.
    const armPing = () => { clearTimeout(pingTimer); pingTimer = setTimeout(() => finish('ping_timeout'), pingTimeout); pingTimer.unref?.() }
    const timer = setTimeout(() => finish('connect_timeout'), timeoutMs); timer.unref?.()
    function finish(reason) {
      if (closed) return
      closed = true; clearTimeout(timer); clearTimeout(pingTimer)
      try { if (socket && socket.readyState <= 1) { if (socket.readyState === 1) socket.send('41'); socket.close() } } catch { /* already closing */ }
      if (!settled) { settled = true; reject(Error(reason)) } else onClose(reason)
    }
    try { socket = new WebSocketImpl(url) } catch { settled = true; closed = true; clearTimeout(timer); reject(Error('socket_unavailable')); return }
    socket.addEventListener('message', ({ data }) => {
      if (closed || typeof data !== 'string' || data.length > MAX_FRAME) return
      const type = data[0]
      if (type === '0') {
        try { const open = JSON.parse(data.slice(1)); if (Number.isFinite(open.pingInterval) && Number.isFinite(open.pingTimeout)) pingTimeout = open.pingInterval + open.pingTimeout } catch { finish('handshake_invalid'); return }
        armPing()
        socket.send(`40${JSON.stringify({ token })}`)
      } else if (type === '2') { armPing(); socket.send('3') }
      else if (type === '1') finish('server_close')
      else if (type === '4') {
        const packet = data.slice(1)
        if (packet[0] === '0') { if (!settled) { settled = true; clearTimeout(timer); resolve(handle) } }
        else if (packet[0] === '4') finish('connect_error')
        else if (packet[0] === '1') finish('server_disconnect')
        else if (packet[0] === '2' && settled) {
          const value = parseEventPacket(packet)
          if (value) { try { onEvent(value.event, ...value.args) } catch { /* a listener error never breaks the link */ } }
        }
      }
    })
    socket.addEventListener('close', () => finish('transport_close'))
    socket.addEventListener('error', () => finish('transport_error'))
  })
}
