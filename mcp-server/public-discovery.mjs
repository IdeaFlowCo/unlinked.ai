import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { renderAgents, renderImportGuide, renderMeet } from './private-onboarding-views.mjs'
import { ONBOARDING_FONT_HREF } from './private-onboarding-style.mjs'

const root = new URL('../', import.meta.url)
const requireFromRoot = createRequire(new URL('package.json', root))
const assets = new Map([
  ['/public-assets/openchat-card.js', ['src/utils/openchat-card.js', 'text/javascript']],
  ['/public-assets/browser-card-scanner.js', ['src/utils/browser-card-scanner.js', 'text/javascript']],
  ['/public-assets/jsqr.js', [() => requireFromRoot.resolve('jsqr/dist/jsQR.js'), 'text/javascript']],
  ['/llms.txt', ['public/llms.txt', 'text/plain']],
  ['/AGENTS.md', ['public/AGENTS.md', 'text/plain']],
  ['/openapi.json', ['public/openapi.json', 'application/json']],
  ['/.well-known/unlinked.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/agent.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/mcp/server-card.json', ['public/.well-known/mcp/server-card.json', 'application/json']],
])
const pages = new Set(['/agents', '/meet', '/import-linkedin'])
export const isPublicDiscoveryPath = pathname => pages.has(pathname) || assets.has(pathname) || pathname === '/public-assets/jsqr-module.mjs'
const meetScript = `import { BrowserCardScanner } from '/public-assets/browser-card-scanner.js';import { parseOpenChatCard,openChatCardUrl } from '/public-assets/openchat-card.js';const status=document.getElementById('status');let scanner;const stop=()=>{scanner?.stop();scanner=null};const go=card=>{stop();location.assign(openChatCardUrl(card))};document.getElementById('paste').addEventListener('submit',event=>{event.preventDefault();const card=parseOpenChatCard(document.getElementById('card-url').value);if(card)go(card);else status.textContent='Use an OpenChat card link from chat.ideaflow.app or chat.globalbr.ai.'});document.getElementById('start').addEventListener('click',async()=>{stop();scanner=new BrowserCardScanner(document.getElementById('camera'),{onCard:go,onUnsupportedCode:()=>{status.textContent='This QR code is not an OpenChat card.'}});try{await scanner.start();status.textContent='Point your camera at an OpenChat card.'}catch{stop();status.textContent='Camera unavailable. Paste the card link instead.'}});document.getElementById('stop').addEventListener('click',stop);addEventListener('pagehide',stop);`
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const document = view => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(view.title)} · Unlinked</title><link rel="stylesheet" href="${ONBOARDING_FONT_HREF}">${view.content}</html>`
const FONT_SOURCES = "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"

// Exact, source-controlled anonymous discovery only. Never resolves an owner,
// reads an import, proxies an arbitrary URL or serves a request-derived file.
// `chrome` is display-only navigation state for a signed-in reader; it grants nothing.
export async function servePublicDiscovery(request, response, pathname, chrome = {}) {
  if (!['GET', 'HEAD'].includes(request.method) || !isPublicDiscoveryPath(pathname)) return false
  let type, content
  if (assets.has(pathname)) {
    const [file, mime] = assets.get(pathname)
    const assetPath = typeof file === 'function' ? file() : new URL(file, root)
    type = mime; content = await readFile(assetPath)
    if (pathname === '/public-assets/browser-card-scanner.js') content = content.toString().replace("from 'jsqr'", "from '/public-assets/jsqr-module.mjs'")
  } else if (pathname === '/public-assets/jsqr-module.mjs') { type = 'text/javascript'; content = 'export default globalThis.jsQR;' }
  else {
    type = 'text/html; charset=utf-8'
    response.setHeader('Content-Security-Policy', `default-src 'none'; ${FONT_SOURCES}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
    if (pathname === '/agents') content = document(renderAgents(chrome))
    if (pathname === '/import-linkedin') content = document(renderImportGuide(chrome))
    if (pathname === '/meet') {
      const nonce = randomBytes(24).toString('base64url')
      response.setHeader('Content-Security-Policy', `default-src 'none'; ${FONT_SOURCES}; script-src 'self' 'nonce-${nonce}'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
      response.setHeader('Permissions-Policy', 'camera=(self), microphone=()')
      content = document(renderMeet(chrome)).replace(/<\/html>$/, '') + `<script nonce="${nonce}" src="/public-assets/jsqr.js"></script><script nonce="${nonce}" type="module">${meetScript}</script></html>`
    }
  }
  response.writeHead(200, { 'Content-Type': type })
  response.end(request.method === 'HEAD' ? undefined : content)
  return true
}
