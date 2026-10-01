import { COMBINED_UPLOAD_CONSENT, requireCombinedUploadConsent } from '../src/utils/private-import/consent.mjs'
import { randomBytes } from 'node:crypto'
import * as oidc from 'openid-client'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'

const token = () => randomBytes(32).toString('base64url')
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
const cookies = request => Object.fromEntries((request.headers.cookie ?? '').split(';').map(value => value.trim().split('=')))

export async function createIdeaflowLogin({ issuer, clientId, clientSecret, callbackUrl, fetchImpl }) {
  const server = new URL(issuer), callback = new URL(callbackUrl)
  if (server.protocol !== 'https:' || server.search || server.hash || server.username || server.password || callback.protocol !== 'https:' || callback.pathname !== '/auth/callback/ideaflow' || callback.search || callback.hash || callback.username || callback.password || !clientId || !clientSecret) throw new Error('explicit_ideaflow_client_required')
  const config = await oidc.discovery(server, clientId, { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(clientSecret), { timeout: 10, execute: [oidc.enableNonRepudiationChecks], ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {}) })
  return {
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce()
      const location = oidc.buildAuthorizationUrl(config, { redirect_uri: callback.href, response_type: 'code', scope: 'openid profile email',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, prompt: 'select_account' })
      return { location: location.href, transaction: { verifier, state, nonce } }
    },
    async finish(url, transaction) {
      const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true })
      const claims = tokens.claims()
      const now = Math.floor(Date.now() / 1000)
      if (!claims || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > now + 30 || claims.exp <= claims.iat || claims.exp <= now || claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || /[\x00-\x1f\x7f]/.test(claims.sub)) throw new Error('verified_ideaflow_identity_required')
      // No access/ID token reaches an agent, cookie or imported source record.
      return { issuer: claims.iss, subject: claims.sub, verifiedEmail: claims.email_verified === true && typeof claims.email === 'string' ? claims.email : null }
    },
  }
}

async function body(request, limit) {
  const parts = []; let size = 0
  for await (const part of request) {
    size += part.length
    if (size > limit) throw new Error('private_body_limit')
    parts.push(part)
  }
  return Buffer.concat(parts)
}

function page(response, title, content, status = 200) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)} · Unlinked</title><style>body{font:18px system-ui;max-width:760px;margin:4rem auto;padding:0 1.5rem;color:#153b33;background:#f4f7f3}h1{font-size:2rem}form,article{padding:1.5rem;margin:1.5rem 0;background:white;border:1px solid #d1ded4;border-radius:12px}label{display:block;margin:1rem 0}input[type=text],textarea{display:block;width:95%;padding:.75rem;font:inherit}button,a.action{display:inline-block;padding:.8rem 1.1rem;background:#155f4d;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}a{color:#155f4d}small{display:block;margin:.75rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><a href="/">Unlinked private pilot</a><h1>${html(title)}</h1>${content}</main></html>`)
}

// Default-off standalone controller. The operator must supply the reviewed
// immutable identity mapping, private backend and independent grant issuer.
// It cannot create/rebind owners from profile URLs, email or upload parameters.
export function createPrivateBrowserHandler({ baseUrl, login, resolveOwner, getBackend, complete, issueGrant, mcpEndpoint, dataMode = 'synthetic' }) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !login?.begin || !login?.finish || typeof resolveOwner !== 'function' || typeof getBackend !== 'function') throw new Error('explicit_private_browser_configuration_required')
  if (!['synthetic', 'private_live'].includes(dataMode)) throw new Error('explicit_private_data_mode_required')
  const pending = new Map(), sessions = new Map()
  const render = (response, title, content, status = 200) => page(response, title,
    (dataMode === 'synthetic' ? '<p><strong>Synthetic rehearsal only. Do not upload a personal archive.</strong></p>' : '') + content, status)
  function purge(map) { for (const [id, value] of map) if (value.expiresAt <= Date.now()) map.delete(id) }
  const sessionFor = request => { purge(sessions); return sessions.get(cookies(request)['__Host-ul-session']) }
  const redirect = (response, location) => { response.writeHead(303, { Location: location }); response.end() }
  const hidden = (session, id) => `<input type="hidden" name="csrf" value="${html(session.csrf)}"><input type="hidden" name="importId" value="${html(id)}">`
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    if (request.headers.host !== base.host) { response.writeHead(403).end(); return }
    if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405).end(); return }
    if (request.method === 'POST' && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    try {
      const url = new URL(request.url, base)
      if (url.origin !== base.origin) { response.writeHead(403).end(); return }
      if (request.method === 'GET' && url.pathname === '/login') {
        purge(pending)
        if (pending.size >= 100) throw new Error('private_login_capacity')
        const result = await login.begin(), id = token()
        pending.set(id, { ...result.transaction, expiresAt: Date.now() + 5 * 60000 })
        response.setHeader('Set-Cookie', cookie('__Host-ul-login', id, 300))
        redirect(response, result.location); return
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback/ideaflow') {
        purge(pending)
        const id = cookies(request)['__Host-ul-login'], transaction = pending.get(id)
        pending.delete(id) // All callback outcomes consume the one-use transaction.
        response.setHeader('Set-Cookie', cookie('__Host-ul-login', '', 0))
        if (!transaction || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== transaction.state || url.searchParams.getAll('code').length !== 1) throw new Error('private_login_transaction_invalid')
        const identity = await login.finish(url, transaction)
        const owner = await resolveOwner(identity)
        if (!owner || typeof owner.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) throw new Error('private_owner_recovery_required')
        purge(sessions)
        if (sessions.size >= 100) throw new Error('private_login_capacity')
        const sessionId = token()
        sessions.set(sessionId, { owner: Object.freeze({ ownerId: owner.ownerId, userId: owner.userId }), csrf: token(), expiresAt: Date.now() + 15 * 60000 })
        response.setHeader('Set-Cookie', [cookie('__Host-ul-login', '', 0), cookie('__Host-ul-session', sessionId, 900)])
        redirect(response, '/'); return
      }
      const session = sessionFor(request)
      if (!session) {
        if (request.method === 'GET' && url.pathname === '/') render(response, 'Your network, privately', '<p>Sign in with Ideaflow to import your own LinkedIn archive. Existing account ownership must be verified before upload.</p><a class="action" href="/login">Continue with Ideaflow</a><p>This isolated pilot accepts up to 100,000 parser records and a 20 MiB archive. Larger imports remain unsupported.</p>')
        else render(response, 'Sign in required', '<a class="action" href="/login">Continue with Ideaflow</a>', 401)
        return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        render(response, 'Import your LinkedIn archive', `<p>Your archive and observations stay scoped to your verified account. Re-uploading the same named archive returns its durable receipt.</p><form method="post" action="/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${html(session.csrf)}"><label>LinkedIn export ZIP or CSV <input required type="file" name="archive" accept=".zip,.csv"></label><small>Maximum 20 MiB and 100,000 parser records. Larger imports fail explicitly and do not publish observations.</small><label><input required type="checkbox" name="consent" value="yes"> I consent to private retention of my archive and observations, and to sending search queries and bounded connection name/company/position/date observations to OpenAI for browser and search-only scoped agent searches.</label>${dataMode === 'synthetic' ? '<label><input required type="checkbox" name="syntheticConsent" value="yes"> This file contains synthetic test data only.</label>' : ''}<button>Import archive</button></form>`)
        return
      }
      const backend = await getBackend(session.owner)
      if (!backend?.adapter || typeof backend.readResource !== 'function') throw new Error('private_backend_unavailable')
      if (request.method === 'POST' && url.pathname === '/upload') {
        const bytes = await body(request, 20 * 1024 * 1024 + 65536)
        const form = await new Request(new URL('/upload', base), { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] ?? '' }, body: bytes }).formData()
        if (form.getAll('csrf').length !== 1 || form.get('csrf') !== session.csrf || form.getAll('consent').length !== 1 || form.get('consent') !== 'yes' || form.getAll('archive').length !== 1 || [...form.keys()].some(key => !['csrf', 'consent', 'archive', 'syntheticConsent'].includes(key))) throw new Error('private_upload_consent_required')
        if (dataMode === 'synthetic' && (form.getAll('syntheticConsent').length !== 1 || form.get('syntheticConsent') !== 'yes')) throw new Error('synthetic_archive_only')
        const file = form.get('archive')
        if (!file || typeof file.arrayBuffer !== 'function' || !file.name || file.name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(file.name) || !/\.(csv|zip)$/i.test(file.name)) throw new Error('private_archive_filename_invalid')
        const receipt = await ingestArchive({ ownerId: session.owner.ownerId, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT })
        redirect(response, `/imports/${receipt.id}`); return
      }
      const importMatch = url.pathname.match(/^\/imports\/([a-f0-9]{64})$/)
      if (request.method === 'GET' && importMatch) {
        const id = importMatch[1], resource = await backend.readResource('import', id)
        if (!resource || resource.deleted || resource.sourceOwnerId !== session.owner.ownerId || resource.payload?.id !== id || resource.payload.receiptOf || resource.payload.kind) { response.writeHead(404).end(); return }
        const job = resource.payload
        render(response, 'Import receipt', `<article><p>Status: <strong>${html(job.status)}</strong>. Accepted: ${html(job.counts.accepted)}. Indexed: ${html(job.counts.indexed)}.</p><p>${job.phase === 'unsupported_private_publication' ? 'This archive exceeds the bounded publication limit. No observations were published.' : html(job.phase)}</p><small>Receipt ${html(id)}<br>Original SHA-256 ${html(job.archiveSha256)}</small></article>${['partial', 'indexed'].includes(job.status) ? `<form method="post" action="/search">${hidden(session, id)}<label>Search this import <input required type="text" maxlength="1024" name="query" placeholder="Who works on distributed systems?"></label><p>Search uses the bounded OpenAI processing authorized at upload.</p><button${typeof complete !== 'function' ? ' disabled' : ''}>Search privately</button>${typeof complete !== 'function' ? '<small>AI credential is not configured.</small>' : '<small>Query-time search; no shared people index.</small>'}</form>${typeof issueGrant === 'function' && mcpEndpoint ? `<form method="post" action="/setup">${hidden(session, id)}<p>Authorize a search-only agent to search this import using the bounded OpenAI processing authorized at upload. The configuration contains a short-lived bearer grant; raw archives are excluded.</p><button>Download scoped agent setup</button></form>` : '<p>Scoped agent setup is not configured.</p>'}` : ''}`)
        return
      }
      if (request.method === 'POST' && ['/search', '/setup', '/logout'].includes(url.pathname)) {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf) throw new Error('private_browser_csrf')
        if (url.pathname === '/logout') { sessions.delete(cookies(request)['__Host-ul-session']); response.setHeader('Set-Cookie', cookie('__Host-ul-session', '', 0)); redirect(response, '/'); return }
        const id = input.get('importId')
        if (input.getAll('importId').length !== 1 || !/^[a-f0-9]{64}$/.test(id)) throw new Error('private_import_not_found')
        const reader = createScopedImportReader({ readResource: backend.readResource, readAsset: backend.readAsset, grant: { ownerId: session.owner.ownerId, importIds: [id] } })
        if (url.pathname === '/search') {
          if (input.getAll('query').length !== 1 || typeof complete !== 'function') throw new Error('private_search_consent_required')
          const controller = new AbortController()
          response.once('close', () => { if (!response.writableFinished) controller.abort() })
          const result = await createPrivateSearch({ readImport: reader, complete })({ importId: id, query: input.get('query'), signal: controller.signal })
          render(response, 'Search results', `<p>${result.matches.length} matching observations.</p>${result.matches.map(match => `<article><h2>${html([match.fields['first name'], match.fields['last name']].filter(Boolean).join(' '))}</h2><p>${html(match.fields.position ?? '')} · ${html(match.fields.company ?? '')}</p><p>${html(match.reason)}</p><small>Source ${html(match.sourceId)}<br>${html(match.rowId)}</small></article>`).join('')}<a href="/imports/${id}">Back to import receipt</a>`)
          return
        }
        if (typeof issueGrant !== 'function' || typeof complete !== 'function') throw new Error('private_agent_setup_unavailable')
        requireCombinedUploadConsent((await reader(id)).consent)
        const accessToken = await issueGrant(session.owner, { importIds: [id], tools: ['unlinked_search_import'] })
        requireCombinedUploadConsent((await reader(id)).consent)
        const config = scopedSetupConfiguration({ endpoint: mcpEndpoint, accessToken })
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="unlinked-private-mcp.json"' })
        response.end(JSON.stringify(config)); return
      }
      response.writeHead(404).end()
    } catch (error) {
      const limited = error.message === 'private_body_limit' || error.message === 'archive_size_limit'
      const recovery = error.message === 'private_owner_recovery_required'
      if (!response.headersSent) render(response, recovery ? 'Account recovery required' : 'Private operation unavailable', recovery ? '<p>Your Ideaflow identity could not be safely mapped to an existing or newly provisioned Unlinked owner. No archive was accepted. Complete the trusted account recovery/provisioning step.</p>' : '<p>The operation did not complete. Retry using your receipt, or return to sign-in. No alternate owner or public backend will be used.</p>', limited ? 413 : recovery ? 409 : 400)
    }
  }
}
