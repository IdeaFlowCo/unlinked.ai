import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

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
function document(title, body) { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Unlinked</title><style>body{font:18px system-ui;max-width:760px;margin:3rem auto;padding:0 1.5rem;color:#272947}a{color:#4349c4}button,input{font:inherit;padding:.6rem}input{max-width:90%}video{max-width:100%}form{margin:1rem 0}</style><main><nav><a href="/">Unlinked</a> · <a href="/login">Sign in with Ideaflow ID</a> · <a href="/agents">Connect your agent</a> · <a href="/meet">Meet</a></nav><h1>${title}</h1>${body}</main></html>` }

// Exact, source-controlled anonymous discovery only. Never resolves an owner,
// reads an import, proxies an arbitrary URL or serves a request-derived file.
export async function servePublicDiscovery(request, response, pathname) {
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
    if (pathname === '/agents') content = document('Connect your agent', '<p>Sign in, open Settings, and create agent setup. Copy the configuration into an MCP client that supports Streamable HTTP and bearer headers.</p><p>Your account-scoped grant searches your current and future imported network until you revoke it in Settings. The grant excludes raw archives and contact details. Keep the configuration private.</p><a href="/login">Sign in to create agent setup</a><p><a href="/llms.txt">Agent guide</a> · <a href="/openapi.json">API description</a></p>')
    if (pathname === '/import-linkedin') content = document('Bring your LinkedIn export', '<p>Request your LinkedIn data export on the LinkedIn website, then import the ZIP after signing in. A complete archive can include your profile, experience, education, skills and connections. Connections-only ZIP or CSV is also supported.</p><p>Maximum archive size: 64 MiB. Processing continues on the server after you leave the page; return to Profile or People for progress. Search and agent setup use your own account’s published records.</p><a href="/login">Sign in and import</a><p><a href="https://www.linkedin.com/mypreferences/d/download-my-data">Request LinkedIn export</a></p>')
    if (pathname === '/meet') {
      const nonce = randomBytes(24).toString('base64url')
      response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
      response.setHeader('Permissions-Policy', 'camera=(self), microphone=()')
      content = document('Meet someone', '<p>Scan or paste an OpenChat card. OpenChat opens the card so you can review the next step there.</p><button id="start">Scan a card</button> <button id="stop">Stop camera</button><div id="camera"></div><form id="paste"><label for="card-url">OpenChat card link</label><input id="card-url" type="url" required><button>Open card</button></form><p id="status" role="status"></p>') + `<script nonce="${nonce}" src="/public-assets/jsqr.js"></script><script nonce="${nonce}" type="module">${meetScript}</script>`
    }
  }
  response.writeHead(200, { 'Content-Type': type })
  response.end(request.method === 'HEAD' ? undefined : content)
  return true
}
