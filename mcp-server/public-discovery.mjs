import { CONNECTION_FEEDBACK_SRC } from './connection-feedback.mjs'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { renderAgents, renderImportGuide, renderMeet, renderSupport, fillMeHeadline, fillNavAlerts, iosAppView, TOP_BAR_SCRIPT, PRIVACY_URL, TERMS_URL } from './private-onboarding-views.mjs'
import { iosAppUserAgent } from '../src/utils/public-people/members-only.mjs'
import { ONBOARDING_FONT_HREF } from './private-onboarding-style.mjs'
import { FEEDBACK_WIDGET_API, FEEDBACK_WIDGET_SITE, feedbackWidgetTag } from './feedback-widget.mjs'

const root = new URL('../', import.meta.url)
const requireFromRoot = createRequire(new URL('package.json', root))
const assets = new Map([
  ['/public-assets/openchat-card.js', ['src/utils/openchat-card.js', 'text/javascript']],
  ['/public-assets/unlinked-card.js', ['src/utils/unlinked-card.js', 'text/javascript']],
  ['/public-assets/meet-scan.js', ['src/utils/meet-scan.js', 'text/javascript']],
  ['/public-assets/linkedin-profile-url.mjs', ['src/utils/linkedin-profile-url.mjs', 'text/javascript']],
  ['/public-assets/browser-card-scanner.js', ['src/utils/browser-card-scanner.js', 'text/javascript']],
  ['/public-assets/jsqr.js', [() => requireFromRoot.resolve('jsqr/dist/jsQR.js'), 'text/javascript']],
  // Installable-app surface: exact source-controlled static files only. The
  // service worker never caches member or session content (see public/sw.js).
  ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['public/sw.js', 'text/javascript']],
  ['/offline.html', ['public/offline.html', 'text/html; charset=utf-8']],
  ['/app-icon-192.png', ['public/app-icon-192.png', 'image/png']],
  // Browsers ask for /favicon.ico on pages without an icon link (the public guides).
  ['/favicon.ico', ['public/app-icon-192.png', 'image/png']],
  ['/app-icon-512.png', ['public/app-icon-512.png', 'image/png']],
  ['/app-icon-maskable-512.png', ['public/app-icon-maskable-512.png', 'image/png']],
  ['/llms.txt', ['public/llms.txt', 'text/plain']],
  // Crawler and security-contact files. Web-reputation scanners treat a site
  // whose robots.txt and security.txt answer 401 like an abandoned or hostile host.
  ['/robots.txt', ['public/robots.txt', 'text/plain']],
  ['/sitemap.xml', ['public/sitemap.xml', 'application/xml']],
  ['/.well-known/security.txt', ['public/.well-known/security.txt', 'text/plain']],
  // Universal links and passkeys for the iOS app (ai.unlinked.app). Apple's CDN
  // fetches this without cookies and never follows a redirect, so it must answer
  // 200 here, before any session or sign-in step. The same bytes are served at the
  // apex by the Vercel project (vercel.json); see docs/ios-universal-links.md.
  ['/.well-known/apple-app-site-association', ['public/.well-known/apple-app-site-association', 'application/json']],
  ['/apple-app-site-association', ['public/.well-known/apple-app-site-association', 'application/json']],
  ['/AGENTS.md', ['public/AGENTS.md', 'text/plain']],
  ['/openapi.json', ['public/openapi.json', 'application/json']],
  ['/.well-known/unlinked.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/agent.json', ['public/.well-known/unlinked.json', 'application/json']],
  ['/.well-known/mcp/server-card.json', ['public/.well-known/mcp/server-card.json', 'application/json']],
])
const pages = new Set(['/agents', '/meet', '/import-linkedin', '/support'])
// Policy addresses people and reviewers type by hand. Unlinked follows the
// Ideaflow policies, so these redirect there (docs/support-and-legal.md).
const redirects = new Map([['/privacy', PRIVACY_URL], ['/privacy-policy', PRIVACY_URL], ['/terms', TERMS_URL], ['/terms-of-service', TERMS_URL], ['/contact', '/support'], ['/help', '/support']])
export const isPublicDiscoveryPath = pathname => pages.has(pathname) || assets.has(pathname) || redirects.has(pathname) || pathname === '/public-assets/jsqr-module.mjs'
// Every scanned or pasted value goes through classifyMeetCode and then a visible
// confirm step; nothing navigates, adds a contact or grants access on scan alone.
export const MEET_SCRIPT = `import { BrowserCardScanner, decodeImageFile } from '/public-assets/browser-card-scanner.js';import { classifyMeetCode } from '/public-assets/meet-scan.js';const status=document.getElementById('status'),confirmBox=document.getElementById('confirm'),confirmLabel=document.getElementById('confirm-label'),confirmOpen=document.getElementById('confirm-open'),UNSUPPORTED='This QR code is not an Unlinked, LinkedIn profile, or OpenChat card.';let scanner=null;const stop=()=>{scanner?.stop();scanner=null};const clear=()=>{confirmBox.hidden=true;confirmOpen.setAttribute('href','/meet');confirmLabel.textContent=''};const offer=code=>{stop();confirmLabel.textContent=code.label;confirmOpen.setAttribute('href',code.href);confirmBox.hidden=false;status.textContent='Nothing opens until you choose Open.'};const howToAllow=()=>{const ua=navigator.userAgent;if(/UnlinkediOS\\//.test(ua))return 'Allow camera in Settings → Unlinked → Camera.';const ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);if(ios&&/CriOS/.test(ua))return 'Allow camera in Settings → Chrome → Camera.';if(ios)return 'In Safari, tap aA in the address bar → Website Settings → Camera → Allow.';if(/Android/.test(ua))return 'Tap the icon next to the address → Permissions → Camera → Allow.';return 'Allow the camera for this site in your browser’s site settings (the icon next to the address).'};const cameraFailed=error=>{stop();const name=error&&error.name,denied=name==='NotAllowedError'||name==='SecurityError';const paste=document.querySelector('.scan-paste');if(paste)paste.open=true;status.textContent=(denied?'Camera access is off. '+howToAllow():'The camera couldn’t start here.')+' You can paste the link or scan from a photo instead.'};document.getElementById('confirm-cancel').addEventListener('click',()=>{clear();status.textContent=''});document.getElementById('paste').addEventListener('submit',event=>{event.preventDefault();const code=classifyMeetCode(document.getElementById('card-url').value);if(code)offer(code);else{clear();status.textContent='Use an Unlinked, LinkedIn profile, or OpenChat card link.'}});document.getElementById('start').addEventListener('click',async()=>{stop();clear();if(!navigator.mediaDevices?.getUserMedia){cameraFailed(null);return}scanner=new BrowserCardScanner(document.getElementById('camera'),{parse:classifyMeetCode,onCard:offer,onUnsupportedCode:()=>{status.textContent=UNSUPPORTED}});try{await scanner.start();status.textContent='Point your camera at a card.'}catch(error){cameraFailed(error)}});document.getElementById('stop').addEventListener('click',stop);const photo=document.getElementById('scan-photo');photo?.addEventListener('change',async()=>{const file=photo.files&&photo.files[0];photo.value='';if(!file)return;stop();clear();status.textContent='Reading the picture…';try{const value=await decodeImageFile(file);if(!value){status.textContent='No QR code found in that picture. Try a closer photo or a screenshot of the code, or paste the link.';return}const code=classifyMeetCode(value);if(code)offer(code);else status.textContent=UNSUPPORTED}catch{status.textContent='That picture couldn’t be read. Try another one, or paste the link.'}});addEventListener('pagehide',stop);`
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
// Every page carries the header's Me-menu script under its own nonce.
// Header counts (`alerts`) are display-only, like the rest of `chrome`.
// In the iOS app (`UnlinkediOS/`), pages get iosAppView and no floating feedback bubble.
const document = (view, { headline, nonce, alerts, ios = false }) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(view.title)} · Unlinked</title><link rel="stylesheet" href="${ONBOARDING_FONT_HREF}">${fillNavAlerts(fillMeHeadline(ios ? iosAppView(view.content) : view.content, headline), alerts)}<script nonce="${nonce}">${TOP_BAR_SCRIPT}</script>${alerts ? `<script nonce="${nonce}" src="${CONNECTION_FEEDBACK_SRC}" defer></script>` : ''}${ios ? '' : feedbackWidgetTag(nonce)}</html>`
const FONT_SOURCES = "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"

// Exact, source-controlled anonymous discovery only. Never resolves an owner,
// reads an import, proxies an arbitrary URL or serves a request-derived file.
// `chrome` is display-only navigation state for a signed-in reader; it grants nothing.
// `signInOrigin` is the runtime's configured Ideaflow ID origin: the Me menu's
// Switch account form redirects there, so it is the one extra form-action.
export async function servePublicDiscovery(request, response, pathname, chrome = {}, { signInOrigin = null } = {}) {
  if (!['GET', 'HEAD'].includes(request.method) || !isPublicDiscoveryPath(pathname)) return false
  let type, content
  if (redirects.has(pathname)) { response.writeHead(302, { Location: redirects.get(pathname) }); response.end(); return true }
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
    const nonce = randomBytes(24).toString('base64url'), page = { headline: chrome.headline, nonce, alerts: chrome.alerts, ios: iosAppUserAgent(request.headers['user-agent']) }
    const formAction = `form-action 'self'${typeof signInOrigin === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(signInOrigin) ? ` ${signInOrigin}` : ''}`
    response.setHeader('Content-Security-Policy', `default-src 'none'; ${FONT_SOURCES}; script-src 'nonce-${nonce}' ${FEEDBACK_WIDGET_SITE}; connect-src 'self' ${FEEDBACK_WIDGET_API} ${FEEDBACK_WIDGET_SITE}; img-src 'self' blob:; media-src 'self' blob:; ${formAction}; base-uri 'none'; frame-ancestors 'none'`)
    if (pathname === '/agents') content = document(renderAgents(chrome), page)
    if (pathname === '/import-linkedin') content = document(renderImportGuide(chrome), page)
    if (pathname === '/support') content = document(renderSupport(chrome), page)
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
