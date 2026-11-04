import { runInNewContext } from 'node:vm'
import { MESSAGES_CLIENT_SOURCE } from '../mcp-server/messages-client.mjs'

// Minimal DOM for exercising the shipped client, not a browser layout engine.
export async function renderedProfileLink({ conversation, dock = false, messages = [] }) {
  class Node {
    constructor(tag = '') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0 }
    setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; if (key === 'class') this.className = value; if (key.startsWith('data-')) this.dataset[key.slice(5)] = value }
    getAttribute(key) { return this.attributes[key] ?? null }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) }
    activate() {
      const event = { target: this, button: 0, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
      for (let node = this; node && !event.stopped; node = node.parent) {
        event.currentTarget = node
        for (const listener of node.listeners.click || []) listener(event)
        node.onclick?.(event)
      }
      return event.defaultPrevented ? null : this.getAttribute('href')
    }
    append(...nodes) { for (const node of nodes) { const child = node instanceof Node ? node : new TextNode(String(node)); child.parent = this; this.children.push(child) } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
    before(node) { this.parent?.append(node) }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
    contains(node) { return this === node || this.children.some(child => child.contains(node)) }
    focus() {}
    getBoundingClientRect() { return { left: 1400 } }
    querySelector() { return null }
    querySelectorAll() { return [] }
    get textContent() { return this.children.map(child => child.textContent).join('') }
    set textContent(value) { this.replaceChildren(String(value)) }
  }
  class TextNode extends Node { constructor(text) { super(); this.text = text } get textContent() { return this.text } set textContent(value) { this.text = value } }
  const root = new Node('main'), app = new Node('div'), list = new Node('ul'), thread = new Node('section'), status = new Node('div')
  for (const [node, id] of [[app, 'msg-app'], [list, 'msg-list'], [thread, 'msg-thread'], [status, 'msg-status']]) node.setAttribute('id', id)
  root.append(app); app.append(list, thread, status)
  if (dock) { const aside = new Node('aside'), toggle = new Node('button'); aside.setAttribute('id', 'msg-dock'); toggle.setAttribute('id', 'msg-dock-toggle'); aside.dataset.expanded = 'false'; root.append(aside); aside.append(toggle, app) }
  const find = (node, fn) => fn(node) ? node : node.children.map(child => find(child, fn)).find(Boolean)
  const config = new Node('script'); config.setAttribute('id', 'msg-config'); config.textContent = JSON.stringify({ csrf: 'fixture', conversationId: dock ? null : conversation.id, dock, reactions: [] }); root.append(config)
  const document = { getElementById: id => find(root, node => node.id === id), createElement: tag => new Node(tag), createTextNode: text => new TextNode(text), querySelector: () => null, addEventListener() {}, visibilityState: 'visible', hasFocus: () => false }
  const storage = values => ({ getItem: key => values[key] ?? null, setItem: (key, value) => { values[key] = value } })
  const fetch = async path => ({ ok: true, json: async () => path === '/messages/api/conversations' ? { me: { id: 'inbox' }, conversations: [conversation] } : path.endsWith('/messages') ? { messages, hasMore: false } : {} })
  class EventSource { addEventListener() {} close() {} }
  runInNewContext(MESSAGES_CLIENT_SOURCE, { document, Node, fetch, EventSource, localStorage: storage({}), sessionStorage: storage(dock ? { 'unlinked.messages.windows': JSON.stringify([{ id: conversation.id }]) } : {}), location: { hash: '', pathname: `/messages/c/${conversation.id}` }, history: {}, matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, innerWidth: 1600, URL, URLSearchParams, navigator: {}, CSS: { escape: value => value } })
  // Let the client's promises finish; no timers or network are involved.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  return find(root, node => node.tagName === 'A' && (node.className === (dock ? 'msg-win-title' : 'msg-thread-person') || (dock && node.parent?.className === 'msg-win-title') || (!dock && node.parent?.className === 'msg-sender')))
}
