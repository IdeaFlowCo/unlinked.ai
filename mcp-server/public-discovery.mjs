import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { renderAgents, renderImportGuide, renderMeet, fillMeHeadline, fillNavAlerts, TOP_BAR_SCRIPT } from './private-onboarding-views.mjs'
import { ONBOARDING_FONT_HREF } from './private-onboarding-style.mjs'
import { FEEDBACK_WIDGET_API, FEEDBACK_WIDGET_SITE, feedbackWidgetTag } from './feedback-widget.mjs'

const root = new URL('../', import.meta.url)
const requireFromRoot = createRequire(new URL('package.json', root))
const assets = new Map([
  ['/public-assets/openchat-card.js', ['src/utils/openchat-card.js', 'text/javascript']],
  ['/public-assets/unlinked-card.js', ['src/utils/unlinked-card.js', 'text/javascript']],
  ['/public-assets/meet-scan.js', ['src/utils/meet-scan.js', 'text/javascript']],
  ['/public-assets/browser-card-scanner.js', ['src/utils/browser-card-scanner.js', 'text/javascript']],
  ['/public-assets/jsqr.js', [() => requireFromRoot.resolve('jsqr/dist/jsQR.js'), 'text/javascript']],
  // Installable-app surface: exact source-controlled static files only. The
  // service worker never caches member or session content (see public/sw.js).
  ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['public/sw.js', 'text/javascript']],
  ['/offline.html', ['public/offline.html', 'text/html; charset=utf-8']],
  ['/app-icon-192.png', ['public/app-icon-192.png', 'image/png']],
  ['/app-icon-512.png', ['public/app-icon-512.png', 'image/png']],
  ['/app-icon-maskable-512.png', ['public/app-icon-maskable-512.png', 'image/png']],
  ['/llms.txt', ['public/llms.txt', 'text/plain']],
  // Crawler and security-contact files. Web-reputation scanners treat a site
  // whose robots.txt and security.txt answer 401 like an abandoned or hostile host.
  ['/robots.txt', ['public/robots.txt', 'text/plain']],
  ['/sitemap.xml', ['public/sitemap.xml', 'application/xml']],
  ['/.well-known/security.txt', ['public/.well-known/security.txt', 'text/plain']],
  ['/AGENTS.md', ['public/AGENTS.md', 'text/plain']],
  ['/openapi.json', ['public/openapi.json', 'application/json']],
  ['/.well-known/unlinked.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/agent.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/mcp/server-card.json', ['public/.well-known/mcp/server-card.json', 'application/json']],
])
const pages = new Set(['/agents', '/meet', '/import-linkedin'])
export const isPublicDiscoveryPath = pathname => pages.has(pathname) || assets.has(pathname) || pathname === '/public-assets/jsqr-module.mjs'
// Every scanned or pasted value goes through classifyMeetCode and then a visible
// confirm step; nothing navigates, adds a contact or grants access on scan alone.
export const MEET_SCRIPT = `import { BrowserCardScanner } from '/public-assets/browser-card-scanner.js';import { classifyMeetCode } from '/public-assets/meet-scan.js';const status=document.getElementById('status'),confirmBox=document.getElementById('confirm'),confirmLabel=document.getElementById('confirm-label'),confirmOpen=document.getElementById('confirm-open');let scanner=null;const stop=()=>{scanner?.stop();scanner=null};const clear=()=>{confirmBox.hidden=true;confirmOpen.setAttribute('href','/meet');confirmLabel.textContent=''};const offer=code=>{stop();confirmLabel.textContent=code.label;confirmOpen.setAttribute('href',code.href);confirmBox.hidden=false;status.textContent='Nothing opens until you choose Open.'};document.getElementById('confirm-cancel').addEventListener('click',()=>{clear();status.textContent=''});document.getElementById('paste').addEventListener('submit',event=>{event.preventDefault();const code=classifyMeetCode(document.getElementById('card-url').value);if(code)offer(code);else{clear();status.textContent='Use an Unlinked profile link or an OpenChat card link.'}});document.getElementById('start').addEventListener('click',async()=>{stop();clear();scanner=new BrowserCardScanner(document.getElementById('camera'),{parse:classifyMeetCode,onCard:offer,onUnsupportedCode:()=>{status.textContent='This QR code is not an Unlinked profile or an OpenChat card.'}});try{await scanner.start();status.textContent='Point your camera at a card.'}catch{stop();status.textContent='Camera unavailable or permission declined. Paste the link printed with the card instead.'}});document.getElementById('stop').addEventListener('click',stop);addEventListener('pagehide',stop);`
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
// Every page carries the header's Me-menu script under its own nonce.
// Header counts (`alerts`) are display-only, like the rest of `chrome`.
const document = (view, { headline, nonce, alerts }) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(view.title)} · Unlinked</title><link rel="stylesheet" href="${ONBOARDING_FONT_HREF}">${fillNavAlerts(fillMeHeadline(view.content, headline), alerts)}<script nonce="${nonce}">${TOP_BAR_SCRIPT}</script>${alerts ? `<script nonce="${nonce}" src="/public-assets/connection-feedback.js"></script>` : ''}${feedbackWidgetTag(nonce)}</html>`
const FONT_SOURCES = "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"

// Exact, source-controlled anonymous discovery only. Never resolves an owner,
// reads an import, proxies an arbitrary URL or serves a request-derived file.
// `chrome` is display-only navigation state for a signed-in reader; it grants nothing.
// `signInOrigin` is the runtime's configured Ideaflow ID origin: the Me menu's
// Switch account form redirects there, so it is the one extra form-action.
export async function servePublicDiscovery(request, response, pathname, chrome = {}, { signInOrigin = null } = {}) {
  if (!['GET', 'HEAD'].includes(request.method) || !isPublicDiscoveryPath(pathname)) return false
  let type, content
  if (assets.has(pathname)) {
    const [file, mime] = assets.get(pathname)
    const assetPath = typeof file === 'function' ? file() : new URL(file, root)
    type = mime; content = await readFile(assetPath)
    // The service worker runs under ITS OWN response's CSP, not the page's.
    // The caller's default (default-src 'none', no connect-src) would block
    // every fetch inside the worker — precaching the shell and the network
    // pass-through — so /sw.js carries the narrowest policy that lets a
    // same-origin-only worker work.
    if (pathname === '/sw.js') response.setHeader('Content-Security-Policy', "default-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
    if (pathname === '/public-assets/browser-card-scanner.js') content = content.toString().replace("from 'jsqr'", "from '/public-assets/jsqr-module.mjs'")
  } else if (pathname === '/public-assets/jsqr-module.mjs') { type = 'text/javascript'; content = 'export default globalThis.jsQR;' }
  else {
    type = 'text/html; charset=utf-8'
    const nonce = randomBytes(24).toString('base64url'), page = { headline: chrome.headline, nonce, alerts: chrome.alerts }
    const formAction = `form-action 'self'${typeof signInOrigin === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(signInOrigin) ? ` ${signInOrigin}` : ''}`
    response.setHeader('Content-Security-Policy', `default-src 'none'; ${FONT_SOURCES}; script-src 'nonce-${nonce}' ${FEEDBACK_WIDGET_SITE}; connect-src 'self' ${FEEDBACK_WIDGET_API} ${FEEDBACK_WIDGET_SITE}; img-src 'self' blob:; media-src 'self' blob:; ${formAction}; base-uri 'none'; frame-ancestors 'none'`)
    if (pathname === '/agents') content = document(renderAgents(chrome), page)
    if (pathname === '/import-linkedin') content = document(renderImportGuide(chrome), page)
    if (pathname === '/meet') {
      response.setHeader('Content-Security-Policy', `default-src 'none'; ${FONT_SOURCES}; script-src 'self' 'nonce-${nonce}' ${FEEDBACK_WIDGET_SITE}; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ${FEEDBACK_WIDGET_API} ${FEEDBACK_WIDGET_SITE}; ${formAction}; base-uri 'none'; frame-ancestors 'none'`)
      response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)')
      content = document(renderMeet(chrome), page).replace(/<\/html>$/, '') + `<script nonce="${nonce}" src="/public-assets/jsqr.js"></script><script nonce="${nonce}" type="module">${MEET_SCRIPT}</script></html>`
    }
  }
  response.writeHead(200, { 'Content-Type': type })
  response.end(request.method === 'HEAD' ? undefined : content)
  return true
}
