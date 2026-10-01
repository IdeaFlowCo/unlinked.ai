import { COMBINED_UPLOAD_CONSENT, requireCombinedUploadConsent } from '../src/utils/private-import/consent.mjs'
import { createHash, randomBytes } from 'node:crypto'
import * as oidc from 'openid-client'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'
import { scopedSetupConfiguration } from '../src/utils/private-import/scoped-setup.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { LIMITS } from '../src/utils/private-import/archive.mjs'
import { stageArchive, importJobStatus } from '../src/utils/private-import/background-job.mjs'
import { readOwnerProfileRows, profileFromRows } from '../src/utils/private-import/owner-profile.mjs'
import { renderJoin, renderBringArchive, renderImporting, renderOwnProfile, renderPeople, renderSettings, uploadProgressScript, agentSetupCopyScript } from './private-onboarding-views.mjs'

const token = () => randomBytes(32).toString('base64url')
const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
const cookies = request => Object.fromEntries((request.headers.cookie ?? '').split(';').map(value => value.trim().split('=')))

export async function createIdeaflowLogin({ issuer, clientId, clientSecret, callbackUrl, fetchImpl }) {
  const server = new URL(issuer), callback = new URL(callbackUrl)
  if (server.protocol !== 'https:' || server.search || server.hash || server.username || server.password || callback.protocol !== 'https:' || callback.pathname !== '/auth/callback/ideaflow' || callback.search || callback.hash || callback.username || callback.password || !clientId || !clientSecret) throw new Error('explicit_ideaflow_client_required')
  const config = await oidc.discovery(server, clientId, { client_secret: clientSecret }, oidc.ClientSecretBasic(clientSecret), { timeout: 10, execute: [oidc.enableNonRepudiationChecks], ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {}) })
  return {
    authorizationOrigin: server.origin,
    async begin() {
      const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce()
      const location = oidc.buildAuthorizationUrl(config, { redirect_uri: callback.href, response_type: 'code', scope: 'openid profile email',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, prompt: 'login' })
      return { location: location.href, transaction: { verifier, state, nonce } }
    },
    async finish(url, transaction) {
      const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: transaction.verifier, expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true })
      const claims = tokens.claims()
      const now = Math.floor(Date.now() / 1000)
      if (!claims || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > now + 30 || claims.exp <= claims.iat || claims.exp <= now || claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || /[\x00-\x1f\x7f]/.test(claims.sub)) throw new Error('verified_ideaflow_identity_required')
      // Prototype policy accepts the authenticated IdP email for display, even
      // without email_verified. Owner authority remains exact signed issuer/sub.
      // No access/ID token reaches an agent, cookie or imported source record.
      return { issuer: claims.iss, subject: claims.sub, clientId, verifiedAt: now, provenanceReceiptId: token(), verifiedEmail: typeof claims.email === 'string' ? claims.email : null }
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
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)} · Unlinked</title><style>body{font:18px system-ui;max-width:760px;margin:4rem auto;padding:0 1.5rem;color:#272947;background:#f4f5fb}h1{font-size:2rem}form,article{padding:1.5rem;margin:1.5rem 0;background:white;border:1px solid #d3d5ea;border-radius:12px}label{display:block;margin:1rem 0}input[type=text],textarea{display:block;width:95%;padding:.75rem;font:inherit}button,a.action{display:inline-block;padding:.8rem 1.1rem;background:#4349c4;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}a{color:#4349c4}small{display:block;margin:.75rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><a href="/">Unlinked</a><h1>${html(title)}</h1>${content}</main></html>`)
}

// Default-off standalone controller. The operator must supply the reviewed
// immutable identity mapping, private backend and independent grant issuer.
// It cannot create/rebind owners from profile URLs, email or upload parameters.
export function createPrivateBrowserHandler({ baseUrl, login, resolveOwner, claimInvitation, signup, getBackend, complete, issueGrant, issueAccountGrant, revokeAccountGrant, mcpEndpoint, dataMode = 'synthetic', backgroundImports = false, audit = async () => {} }) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !login?.begin || !login?.finish || typeof resolveOwner !== 'function' || typeof getBackend !== 'function') throw new Error('explicit_private_browser_configuration_required')
  if (!['synthetic', 'private_live'].includes(dataMode)) throw new Error('explicit_private_data_mode_required')
  if (claimInvitation !== undefined && typeof claimInvitation !== 'function') throw new Error('explicit_private_invitation_configuration_required')
  if (signup !== undefined && (typeof signup !== 'function' || typeof issueAccountGrant !== 'function' || typeof revokeAccountGrant !== 'function')) throw new Error('account_signup_configuration_required')
  const invitationMode = typeof claimInvitation === 'function' && typeof signup !== 'function'
  const authorizationOrigin = login.authorizationOrigin ?? null
  if (invitationMode && authorizationOrigin === null) throw new Error('explicit_private_authorization_origin_required')
  if (authorizationOrigin !== null) {
    const authorization = new URL(authorizationOrigin)
    if (authorization.protocol !== 'https:' || authorization.origin !== authorizationOrigin) throw new Error('explicit_private_authorization_origin_required')
  }
  const pending = new Map(), invitations = new Map(), confirmations = new Map(), sessions = new Map()
  let uploadBusy = false
  const render = (response, title, content, status = 200) => page(response, title,
    (dataMode === 'synthetic' ? '<p><strong>Synthetic rehearsal only. Do not upload a personal archive.</strong></p>' : '') + content, status)
  function purge(map) { for (const [id, value] of map) if (value.expiresAt <= Date.now()) map.delete(id) }
  const sessionFor = request => { purge(sessions); return sessions.get(cookies(request)['__Host-ul-session']) }
  const redirect = (response, location) => { response.writeHead(303, { Location: location }); response.end() }
  const hidden = (session, id) => `<input type="hidden" name="csrf" value="${html(session.csrf)}"><input type="hidden" name="importId" value="${html(id)}">`
  const recordAudit = async event => { try { await audit({ ...event, at: new Date().toISOString(), origin: base.origin }) } catch { /* Audit availability never changes identity authority. */ } }
  const journey = (response, view, job = null, script = '') => {
    const nonce = token()
    response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
    if (job && ['uploaded', 'parsing', 'indexing'].includes(job.status)) script += `;let timer=setInterval(async()=>{try{const r=await fetch(${JSON.stringify(job.statusUrl)},{credentials:'same-origin'});if(!r.ok){clearInterval(timer);return}const j=await r.json();const el=document.querySelector('.import-status');if(el){el.textContent='Importing'+(j.total===null?'':' · '+Math.floor(j.processed*100/Math.max(1,j.total))+'% · '+j.processed+' of '+j.total)}if(['indexed','partial','failed'].includes(j.status)||(!${JSON.stringify(job.profileReady)}&&j.profileReady)){clearInterval(timer);location.reload()}}catch{}},2000);`
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(view.title)} · Unlinked</title>${dataMode === 'synthetic' ? '<p>Synthetic rehearsal only. Do not upload a personal archive.</p>' : ''}${view.content}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`)
  }
  const displayIdentity = identity => identity.verifiedEmail ? html(identity.verifiedEmail) : `${html(identity.issuer)} / ${html(identity.subject)}`
  async function establishSession(response, identity, invitationToken = null) {
    let claimed
    if (invitationToken) {
      if (typeof claimInvitation !== 'function') throw new Error('private_invitation_intent_invalid')
      claimed = await claimInvitation(invitationToken, {
        issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId,
        verifiedAt: identity.verifiedAt, provenanceReceiptId: identity.provenanceReceiptId, newProfileIntent: true,
      })
      if (!claimed || typeof claimed.ownerId !== 'string' || !claimed.ownerId || typeof claimed.userId !== 'string' || !claimed.userId) throw new Error('private_owner_recovery_required')
    }
    let owner = await resolveOwner(identity)
    if (!owner && !invitationToken && typeof signup === 'function') {
      const provisioned = await signup({ issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId,
        verifiedAt: identity.verifiedAt, provenanceReceiptId: identity.provenanceReceiptId, newProfileIntent: true })
      owner = await resolveOwner(identity)
      if (!provisioned || provisioned.ownerId !== owner?.ownerId || provisioned.userId !== owner?.userId) throw new Error('private_owner_recovery_required')
    }
    if (!owner || typeof owner.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) throw new Error('private_owner_recovery_required')
    if (claimed && (claimed.ownerId !== owner.ownerId || claimed.userId !== owner.userId)) throw new Error('private_owner_recovery_required')
    purge(sessions)
    if (sessions.size >= 100) throw new Error('private_login_capacity')
    const sessionId = token()
    sessions.set(sessionId, { owner: Object.freeze({ ownerId: owner.ownerId, userId: owner.userId }), accountLabel: identity.verifiedEmail ?? identity.subject, csrf: token(), expiresAt: Date.now() + 15 * 60000 })
    response.setHeader('Set-Cookie', [cookie('__Host-ul-login', '', 0), cookie('__Host-ul-confirm', '', 0), cookie('__Host-ul-session', sessionId, 900)])
    await recordAudit({ event: 'auth_session_created', ownerHash: createHash('sha256').update(owner.ownerId).digest('hex') })
    redirect(response, '/')
  }
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'strict-origin')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    if (request.headers.host !== base.host) { response.writeHead(403).end(); return }
    if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405).end(); return }
    if (request.method === 'POST' && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    try {
      const url = new URL(request.url, base)
      if (url.origin !== base.origin) { response.writeHead(403).end(); return }
      const inviteMatch = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})$/)
      if (request.method === 'GET' && inviteMatch && invitationMode) {
        purge(invitations)
        if (invitations.size >= 100) throw new Error('private_login_capacity')
        const id = token(), csrf = token()
        invitations.set(id, { token: inviteMatch[1], csrf, expiresAt: Date.now() + 5 * 60000 })
        response.setHeader('Set-Cookie', cookie('__Host-ul-invite', id, 300))
        if (authorizationOrigin) response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${authorizationOrigin}; base-uri 'none'; frame-ancestors 'none'`)
        render(response, 'Start your private Unlinked profile', `<p>Sign in with Ideaflow for this separate, private Unlinked profile. After Ideaflow returns, Unlinked shows the verified account and asks you to confirm it before creating your owner. Your existing OpenChat account stays separate.</p><form method="post" action="/invite"><input type="hidden" name="csrf" value="${html(csrf)}"><p>You can review the archive retention and AI search disclosure when you upload.</p><button>Continue with Ideaflow</button></form>`)
        return
      }
      if (request.method === 'POST' && url.pathname === '/invite' && invitationMode) {
        purge(invitations); purge(pending); purge(confirmations)
        const id = cookies(request)['__Host-ul-invite'], invitation = invitations.get(id)
        invitations.delete(id)
        response.setHeader('Set-Cookie', cookie('__Host-ul-invite', '', 0))
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (!invitation || input.getAll('csrf').length !== 1 || input.get('csrf') !== invitation.csrf || [...input.keys()].some(key => key !== 'csrf')) throw new Error('private_invitation_intent_invalid')
        if (pending.size >= 100) throw new Error('private_login_capacity')
        const result = await login.begin(), transactionId = token()
        pending.set(transactionId, { ...result.transaction, invitationToken: invitation.token, newProfileIntent: true, expiresAt: Date.now() + 5 * 60000 })
        response.setHeader('Set-Cookie', [cookie('__Host-ul-invite', '', 0), cookie('__Host-ul-login', transactionId, 300)])
        redirect(response, result.location); return
      }
      if (request.method === 'POST' && url.pathname === '/invite/confirm' && invitationMode) {
        purge(confirmations); purge(pending)
        const id = cookies(request)['__Host-ul-confirm'], confirmation = confirmations.get(id)
        confirmations.delete(id)
        response.setHeader('Set-Cookie', cookie('__Host-ul-confirm', '', 0))
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (!confirmation || input.getAll('csrf').length !== 1 || input.get('csrf') !== confirmation.csrf || input.getAll('action').length !== 1 || [...input.keys()].some(key => !['csrf', 'action'].includes(key))) throw new Error('private_invitation_intent_invalid')
        const action = input.get('action')
        if (action === 'cancel') { redirect(response, '/'); return }
        if (action === 'restart') {
          if (pending.size >= 100) throw new Error('private_login_capacity')
          const result = await login.begin(), transactionId = token()
          pending.set(transactionId, { ...result.transaction, invitationToken: confirmation.invitationToken, newProfileIntent: true, expiresAt: Date.now() + 5 * 60000 })
          response.setHeader('Set-Cookie', [cookie('__Host-ul-confirm', '', 0), cookie('__Host-ul-login', transactionId, 300)])
          redirect(response, result.location); return
        }
        if (action !== 'confirm') throw new Error('private_invitation_intent_invalid')
        await establishSession(response, confirmation.identity, confirmation.invitationToken); return
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        purge(pending)
        if (pending.size >= 100) throw new Error('private_login_capacity')
        const result = await login.begin(), id = token()
        pending.set(id, { ...result.transaction, expiresAt: Date.now() + 5 * 60000 })
        response.setHeader('Set-Cookie', cookie('__Host-ul-login', id, 300))
        redirect(response, result.location); return
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback/ideaflow') {
        purge(pending); purge(confirmations)
        const id = cookies(request)['__Host-ul-login'], transaction = pending.get(id)
        pending.delete(id) // All callback outcomes consume the one-use transaction.
        response.setHeader('Set-Cookie', cookie('__Host-ul-login', '', 0))
        if (!transaction || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== transaction.state || url.searchParams.getAll('code').length !== 1) throw new Error('private_login_transaction_invalid')
        const identity = await login.finish(url, transaction)
        if (transaction.invitationToken) {
          if (typeof claimInvitation !== 'function' || transaction.newProfileIntent !== true) throw new Error('private_invitation_intent_invalid')
          if (confirmations.size >= 100) throw new Error('private_login_capacity')
          const confirmationId = token(), csrf = token()
          confirmations.set(confirmationId, { identity, invitationToken: transaction.invitationToken, csrf, expiresAt: Date.now() + 5 * 60000 })
          response.setHeader('Set-Cookie', [cookie('__Host-ul-login', '', 0), cookie('__Host-ul-confirm', confirmationId, 300)])
          response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${authorizationOrigin}; base-uri 'none'; frame-ancestors 'none'`)
          render(response, 'Confirm your Ideaflow account', `<p>Ideaflow returned this verified account for your invitation. Confirm it here before Unlinked creates a private owner for the invitation.</p><article><strong>${displayIdentity(identity)}</strong></article><form method="post" action="/invite/confirm"><input type="hidden" name="csrf" value="${html(csrf)}"><button name="action" value="confirm">Use this account</button><button name="action" value="restart">Use another account</button><button name="action" value="cancel">Cancel</button></form>`)
          return
        }
        await establishSession(response, identity); return
      }
      const session = sessionFor(request)
      if (!session) {
        if (request.method === 'GET' && url.pathname === '/') journey(response, renderJoin())
        else render(response, 'Sign in required', '<a class="action" href="/login">Continue with Ideaflow</a>', 401)
        return
      }
      const accountNav = `<nav><a href="/">Import</a> · <a href="/network">My network</a> · <a href="/settings">Agent setup & settings</a></nav><small>Signed in as ${html(session.accountLabel)}</small><form method="post" action="/logout"><input type="hidden" name="csrf" value="${html(session.csrf)}"><button>Sign out</button></form>`
      const backend = await getBackend(session.owner)
      if (!backend?.adapter || typeof backend.readResource !== 'function') throw new Error('private_backend_unavailable')
      const jobResources = async () => {
        const ids = signup ? await (backend.listImportJobIds ?? backend.listImportIds)() : []
        const resources = []
        for (let start = 0; start < ids.length; start += 8) resources.push(...await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id))))
        return resources.filter(resource => resource && !resource.deleted && resource.sourceOwnerId === session.owner.ownerId && resource.payload?.id === resource.sourceId && !resource.payload.kind && !resource.payload.receiptOf)
      }
      const profileJobs = jobs => [...jobs].sort((a, b) => {
        const key = resource => {
          if (resource.payload.backgroundVersion !== 'profile-first-v1') return [0, 0, resource.sourceId]
          if (!Number.isSafeInteger(resource.payload.createdAt)) throw new Error('private_import_created_at_invalid')
          return [1, resource.payload.createdAt, resource.sourceId]
        }
        const left = key(a), right = key(b)
        return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2])
      })
      const jobProps = jobs => {
        const ordered = [...jobs].sort((a, b) => (b.payload.createdAt ?? 0) - (a.payload.createdAt ?? 0))
        const active = ordered.find(resource => ['uploaded', 'parsing', 'indexing'].includes(resource.payload.status)) ?? ordered.find(resource => resource.payload.backgroundVersion)
        return { accountLabel: session.accountLabel, csrf: session.csrf, importJob: active ? importJobStatus(active.payload) : undefined }
      }
      const summaries = jobs => jobs.map(({ sourceId, payload }) => ({ id: sourceId, filename: payload.filename, sha256: payload.archiveSha256, status: payload.status, accepted: payload.counts.accepted, indexed: payload.counts.indexed }))
      const statusMatch = url.pathname.match(/^\/imports\/([a-f0-9]{64})\/status$/)
      if (request.method === 'GET' && statusMatch) {
        const resource = await backend.readResource('import', statusMatch[1])
        if (!resource || resource.deleted || resource.sourceOwnerId !== session.owner.ownerId || resource.payload?.ownerId !== session.owner.ownerId || resource.payload.id !== statusMatch[1] || resource.payload.kind || resource.payload.receiptOf) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(importJobStatus(resource.payload))); return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        if (signup) { const jobs = await jobResources(); const props = jobProps(jobs); journey(response, renderBringArchive({ ...props, limitBytes: LIMITS.archiveBytes, syntheticMode: dataMode === 'synthetic' }), props.importJob, uploadProgressScript()); return }
        const ids = signup ? await backend.listImportIds() : []
        const jobs = await Promise.all(ids.map(id => backend.readResource('import', id)))
        render(response, 'Import your LinkedIn archive', `${signup ? accountNav : ''}<p>Complete archive preferred. Connections-only ZIP or CSV also works. Re-uploading the same named archive returns its durable receipt.</p><form method="post" action="/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${html(session.csrf)}"><label>LinkedIn export ZIP or CSV <input required type="file" name="archive" accept=".zip,.csv"></label><small>Maximum 64 MiB and 100,000 parser records. Larger imports fail explicitly and do not publish observations.</small><p>By importing, your profile and connections join your Unlinked network, searchable by you and by any agent you connect. Contact details stay private.</p>${dataMode === 'synthetic' ? '<label><input required type="checkbox" name="syntheticConsent" value="yes"> This file contains synthetic test data only.</label>' : ''}<button>Import archive</button></form>${signup ? `<h2>Your imports</h2>${jobs.filter(job => job && !job.deleted && job.sourceOwnerId === session.owner.ownerId).map(job => `<article><a href="/imports/${html(job.sourceId)}">${html(job.payload.filename)}</a><p>${html(job.payload.counts?.indexed ?? 0)} observations indexed</p></article>`).join('') || '<p>Your first upload will appear here.</p>'}` : ''}`)
        return
      }
      if (signup && request.method === 'GET' && url.pathname === '/profile') {
        const jobs = await jobResources(), props = jobProps(jobs)
        if (props.importJob && ['uploaded', 'parsing', 'indexing'].includes(props.importJob.status) && !props.importJob.profileReady) { journey(response, renderImporting(props), props.importJob); return }
        const profile = profileFromRows(await readOwnerProfileRows({ ownerId: session.owner.ownerId, jobs: profileJobs(jobs), backend }))
        journey(response, renderOwnProfile({ ...props, profile, imports: summaries(jobs) }), props.importJob); return
      }
      if (signup && request.method === 'GET' && url.pathname === '/network') {
        const network = await createAccountNetwork({ owner: session.owner, getBackend }).readNetwork()
        const connections = network.assertions.filter(row => row.category === 'connections')
        const filter = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        if (filter.length > 256) throw new Error('network_filter_limit')
        const rows = connections.filter(row => !filter || [row.fields['first name'], row.fields['last name'], row.fields.company, row.fields.position].some(value => value?.toLowerCase().includes(filter)))
        const index = Number(url.searchParams.get('page') ?? '0')
        if (!Number.isSafeInteger(index) || index < 0 || index > 1000) throw new Error('network_page_limit')
        const props = jobProps(await jobResources()), contacts = rows.slice(index * 100, (index + 1) * 100).map(row => ({ name: [row.fields['first name'], row.fields['last name']].filter(Boolean).join(' '), headline: row.fields.position, company: row.fields.company, linkedinUrl: row.fields.url }))
        const view = renderPeople({ ...props, contacts, query: filter })
        if (rows.length > (index + 1) * 100) view.content += `<a href="/network?page=${index + 1}&q=${encodeURIComponent(filter)}">Next contacts</a>`
        journey(response, view, props.importJob)
        return
      }
      if (signup && request.method === 'GET' && url.pathname === '/settings') {
        const ids = await backend.listAccountGrantIds()
        const jobs = await jobResources(), props = jobProps(jobs)
        journey(response, renderSettings({ ...props, grants: ids.map(id => ({ id })), imports: summaries(jobs) }), props.importJob)
        return
      }
      if (signup && request.method === 'POST' && ['/setup-account', '/revoke-account', '/search-account'].includes(url.pathname)) {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf) throw new Error('private_browser_csrf')
        if (url.pathname === '/revoke-account') {
          if (input.getAll('grantId').length !== 1) throw new Error('account_grant_not_found')
          await revokeAccountGrant(session.owner, input.get('grantId')); redirect(response, '/settings'); return
        }
        if (url.pathname === '/search-account') {
          if (input.getAll('query').length !== 1) throw new Error('private_search_query_limit')
          const controller = new AbortController()
          response.once('close', () => { if (!response.writableFinished) controller.abort() })
          const result = await createAccountNetwork({ owner: session.owner, getBackend, complete }).search({ query: input.get('query'), signal: controller.signal })
          const props = jobProps(await jobResources())
          const view = renderPeople({ ...props, query: input.get('query'), searchResults: result.matches.map(match => ({ name: [match.fields['first name'], match.fields['last name']].filter(Boolean).join(' '), headline: match.fields.position, company: match.fields.company, linkedinUrl: match.fields.url, reason: match.reason })) })
          view.content += `<p>${result.considered} connection observations searched across your own files.</p>`
          journey(response, view, props.importJob); return
        }
        const { accessToken } = await issueAccountGrant(session.owner)
        const configuration = scopedSetupConfiguration({ endpoint: mcpEndpoint, accessToken })
        const jobs = await jobResources(), props = jobProps(jobs)
        const grants = await backend.listAccountGrantIds()
        journey(response, renderSettings({ ...props, imports: summaries(jobs), grants: grants.map(id => ({ id })), agentConfiguration: configuration }), props.importJob, agentSetupCopyScript()); return
      }
      if (request.method === 'POST' && url.pathname === '/upload') {
        if (uploadBusy) { response.writeHead(429, { 'Retry-After': '10' }).end(); return }
        uploadBusy = true
        try {
        const bytes = await body(request, LIMITS.archiveBytes + 65536)
        const form = await new Request(new URL('/upload', base), { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] ?? '' }, body: bytes }).formData()
        if (form.getAll('csrf').length !== 1 || form.get('csrf') !== session.csrf || form.getAll('archive').length !== 1 || [...form.keys()].some(key => !['csrf', 'archive', 'syntheticConsent'].includes(key))) throw new Error('private_browser_csrf')
        if (dataMode === 'synthetic' && (form.getAll('syntheticConsent').length !== 1 || form.get('syntheticConsent') !== 'yes')) throw new Error('synthetic_archive_only')
        const file = form.get('archive')
        if (!file || typeof file.arrayBuffer !== 'function' || !file.name || file.name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(file.name) || !/\.(csv|zip)$/i.test(file.name)) throw new Error('private_archive_filename_invalid')
        const receipt = await (backgroundImports ? stageArchive : ingestArchive)({ ownerId: session.owner.ownerId, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT })
        redirect(response, signup ? '/profile' : `/imports/${receipt.id}`); return
        } finally { uploadBusy = false }
      }
      const importMatch = url.pathname.match(/^\/imports\/([a-f0-9]{64})$/)
      if (request.method === 'GET' && importMatch) {
        const id = importMatch[1], resource = await backend.readResource('import', id)
        if (!resource || resource.deleted || resource.sourceOwnerId !== session.owner.ownerId || resource.payload?.id !== id || resource.payload.receiptOf || resource.payload.kind) { response.writeHead(404).end(); return }
        const job = resource.payload
        render(response, 'Import receipt', `<article><p>Status: <strong>${html(job.status)}</strong>. Accepted: ${html(job.counts.accepted)}. Indexed: ${html(job.counts.indexed)}.</p><p>${job.phase === 'unsupported_private_publication' ? 'This archive exceeds the bounded publication limit. No observations were published.' : html(job.phase)}</p><small>Receipt ${html(id)}<br>Original SHA-256 ${html(job.archiveSha256)}</small></article>${['partial', 'indexed'].includes(job.status) ? `<form method="post" action="/search">${hidden(session, id)}<label>Search this import <input required type="text" maxlength="1024" name="query" placeholder="Who works on distributed systems?"></label><p>Search uses the bounded OpenAI processing authorized at upload.</p><button${typeof complete !== 'function' ? ' disabled' : ''}>Search privately</button>${typeof complete !== 'function' ? '<small>AI credential is not configured.</small>' : '<small>Query-time search; no shared people index.</small>'}</form>${!signup && typeof issueGrant === 'function' && mcpEndpoint ? `<form method="post" action="/setup">${hidden(session, id)}<p>Authorize a search-only agent to search this import using the bounded OpenAI processing authorized at upload. The configuration contains a short-lived bearer grant; raw archives are excluded.</p><button>Download scoped agent setup</button></form>` : signup ? '<p><a href="/network">Search my whole network</a> · <a href="/settings">Connect my agent</a></p>' : '<p>Scoped agent setup is not configured.</p>'}` : ''}`)
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
        if (signup || typeof issueGrant !== 'function' || typeof complete !== 'function') throw new Error('private_agent_setup_unavailable')
        requireCombinedUploadConsent((await reader(id)).consent)
        const accessToken = await issueGrant(session.owner, { importIds: [id], tools: ['unlinked_search_import'] })
        requireCombinedUploadConsent((await reader(id)).consent)
        const config = scopedSetupConfiguration({ endpoint: mcpEndpoint, accessToken })
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="unlinked-private-mcp.json"' })
        response.end(JSON.stringify(config)); return
      }
      response.writeHead(404).end()
    } catch (error) {
      if (new URL(request.url, base).pathname === '/auth/callback/ideaflow') await recordAudit({ event: 'auth_callback_denied', reason: ['private_login_transaction_invalid', 'private_owner_recovery_required'].includes(error.message) ? error.message : 'oidc_or_owner_validation_failed' })
      const limited = error.message === 'private_body_limit' || error.message === 'archive_size_limit'
      const recovery = error.message === 'private_owner_recovery_required'
      if (!response.headersSent) render(response, recovery ? 'Account recovery required' : 'We could not finish that', recovery ? '<p>Your Ideaflow identity could not be safely mapped to an existing or newly provisioned Unlinked owner. No archive was accepted. Complete the trusted account recovery/provisioning step.</p>' : '<p>Try again, or sign in and return to your files in Settings. Your account and files have not been moved to another account.</p><a href="/settings">Open Settings</a>', limited ? 413 : recovery ? 409 : 400)
    }
  }
}
