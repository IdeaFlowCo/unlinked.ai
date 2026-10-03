import { createKnownConnectionsReader } from '../src/utils/public-people/known-connections.mjs'
import { createPublicPeopleReader, PublicPeopleReaderError, PRESENCE } from '../src/utils/public-people/reader.mjs'
import { createSharedPeopleSearch } from '../src/utils/public-people/shared-search.mjs'
import { SEARCH_MODES, createQueryMatcher, rankMatches, words } from '../src/utils/public-people/text-match.mjs'
import { linkedinSlug } from '../src/utils/public-people/url-identity.mjs'
import { isPublicDiscoveryPath, servePublicDiscovery } from './public-discovery.mjs'
import { COMBINED_UPLOAD_CONSENT, PUBLIC_UPLOAD_CONSENT, requireCombinedUploadConsent } from '../src/utils/private-import/consent.mjs'
import { createHash, randomBytes } from 'node:crypto'
import * as oidc from 'openid-client'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { createScopedImportReader } from '../src/utils/private-import/noos-adapter.mjs'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'
import { scopedSetupConfiguration, agentClientSetups } from '../src/utils/private-import/scoped-setup.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { LIMITS, linkedinUrl } from '../src/utils/private-import/archive.mjs'
import { stageArchive, importJobStatus, importErrorMessage, ADDED_PERSON } from '../src/utils/private-import/background-job.mjs'
import { InvitationError, INVITATION_TOKEN } from './member-invitations.mjs'
import { ConnectionError } from './member-connections.mjs'
import { emailAddress, EMAIL_PREFERENCES } from './member-email.mjs'
import { createConnectionActions } from './connection-actions.mjs'
import { ACCOUNT_WRITE_SCOPE, missingAccountGrantTools } from './account-grants.mjs'
import { readOwnerProfileRows, profileFromRows } from '../src/utils/private-import/owner-profile.mjs'
import { exportAccountData, deleteAccountData } from '../src/utils/private-import/account-data.mjs'
import { renderLanding, renderJoin, renderSignInRequired, renderBringArchive, renderImporting, renderOwnProfile, renderFindMe, renderCard, renderContactCard, renderPerson, renderPeople, renderCompany, renderSettings, renderAddPerson, renderInvites, renderInviteLanding, renderDataDeleted, renderEmailUnsubscribe, renderInvitations, renderNotifications, fillNavAlerts, connectNoticeCodes, uploadProgressScript, agentSetupCopyScript } from './private-onboarding-views.mjs'
import { companyFacts } from './company-metadata.mjs'
import { qrSvg } from '../src/utils/qr-code.mjs'
import { ContactCardError, renderContactVcard } from './contact-card.mjs'
import { ONBOARDING_FONT_HREF } from './private-onboarding-style.mjs'
import { renderScan, fillMeHeadline, TOP_BAR_SCRIPT, SCAN_TABS_SCRIPT, renderConnectorConsent, renderConnectorError } from './private-onboarding-views.mjs'
import { MEET_SCRIPT } from './public-discovery.mjs'

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
      return { issuer: claims.iss, subject: claims.sub, clientId, verifiedAt: now, provenanceReceiptId: token(), emailEvidence: 'signed-ideaflow-beta-v1', providerEmailVerified: claims.email_verified === true, verifiedEmail: typeof claims.email === 'string' ? claims.email : null, displayName: typeof claims.name === 'string' && claims.name.length <= 256 ? claims.name : null }
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
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#4349c4"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>${html(title)} · Unlinked</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/app-icon-192.png"><link rel="icon" href="/app-icon-192.png" type="image/png"><style>body{font:17px/1.55 system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:0 1.5rem 3rem;color:#16181d;background:#f5f6fc}main>a:first-child{display:block;padding:24px 0;margin-bottom:2rem;border-bottom:1px solid #e6e8ec;font-weight:700;font-size:21px;letter-spacing:-.04em;text-decoration:none;text-transform:lowercase}h1{font-size:2rem;letter-spacing:-.03em;line-height:1.1}form,article{padding:1.25rem 1.4rem;margin:1rem 0;background:white;border:1px solid #e6e8ec;border-radius:8px}label{display:block;margin:1rem 0}input[type=text],textarea{display:block;width:95%;padding:.75rem;font:inherit}button,a.action{display:inline-block;padding:.7rem 1.2rem;margin:.2rem .3rem .2rem 0;background:#4349c4;color:white;border:0;border-radius:8px;font:600 16px system-ui;cursor:pointer;text-decoration:none}a{color:#32379c}small{display:block;margin:.75rem 0;color:#667085}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><a href="/">Unlinked</a><h1>${html(title)}</h1>${content}</main></html>`)
}

// Default-off standalone controller. The operator must supply the reviewed
// immutable identity mapping, private backend and independent grant issuer.
// It cannot create/rebind owners from profile URLs, email or upload parameters.
// The published person each own connection row should link to, or null.
// A row tries its own published person first, then an existing public profile
// with the same LinkedIn address (old shadow profiles, rows of private-consent
// imports). Only people the reader finds are linked, so links never 404.
export async function publishedPeopleFor(rows, { publicTarget, lookupSlug, lookup }) {
  const usable = id => typeof id === 'string' && id && id.length <= 160 && id !== '.' && id !== '..' ? id : null
  const bySlug = async row => {
    const slug = lookupSlug && row.fields?.url ? linkedinSlug(row.fields.url) : null
    return slug ? usable(await Promise.resolve(lookupSlug(slug)).catch(() => null)) : null
  }
  const candidates = await Promise.all(rows.map(async row => [usable(publicTarget(row)), await bySlug(row)]))
  const found = await lookup([...new Set(candidates.flat().filter(Boolean))].slice(0, 1000))
  return candidates.map(ids => ids.map(id => id && found.get(id)).find(Boolean) ?? null)
}

export function createPrivateBrowserHandler({ baseUrl, login, resolveOwner, claimInvitation, signup, memberInvitations, memberConnections, notifications, contactCards, accountForProfile, ownProfileId, notifyProfileClaimed, legacyAccount, selfClaims, getBackend, complete, readPublishedSnapshot, issueGrant, issueAccountGrant, ensureAccountGrant, revokeAccountGrant, revokeLegacyLink, removeOwnerAssets, mcpEndpoint, dataMode = 'synthetic', backgroundImports = false, audit = async () => {}, oauth, listAccountGrants, sessionStore, memberEmail }) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password || !login?.begin || !login?.finish || typeof resolveOwner !== 'function' || typeof getBackend !== 'function') throw new Error('explicit_private_browser_configuration_required')
  if (!['synthetic', 'private_live'].includes(dataMode)) throw new Error('explicit_private_data_mode_required')
  if (claimInvitation !== undefined && typeof claimInvitation !== 'function') throw new Error('explicit_private_invitation_configuration_required')
  if (memberInvitations !== undefined && ['create', 'list', 'open', 'respond', 'revoke', 'removeOwner'].some(key => typeof memberInvitations[key] !== 'function')) throw new Error('member_invitation_configuration_required')
  if (memberConnections !== undefined && (['send', 'respond', 'withdraw', 'received', 'sent', 'pendingCount', 'between', 'removeOwner'].some(key => typeof memberConnections[key] !== 'function') || typeof accountForProfile !== 'function')) throw new Error('member_connection_configuration_required')
  if (notifications !== undefined && ['list', 'counts', 'markSeen', 'open', 'markAllRead', 'removeOwner'].some(key => typeof notifications[key] !== 'function')) throw new Error('notification_configuration_required')
  if (memberEmail !== undefined && (typeof memberEmail.sending !== 'boolean' || ['rememberAddress', 'settings', 'savePreferences', 'sendInvite', 'inspectUnsubscribe', 'unsubscribe', 'exportOwner', 'removeOwner'].some(key => typeof memberEmail[key] !== 'function'))) throw new Error('member_email_configuration_required')
  if (contactCards !== undefined && ['read', 'save', 'rotate', 'syncIdentity', 'open', 'exportOwner', 'removeOwner'].some(key => typeof contactCards[key] !== 'function')) throw new Error('contact_card_configuration_required')
  if (signup !== undefined && (typeof signup !== 'function' || typeof issueAccountGrant !== 'function' || typeof revokeAccountGrant !== 'function')) throw new Error('account_signup_configuration_required')
  if (ensureAccountGrant !== undefined && typeof ensureAccountGrant !== 'function') throw new Error('account_signup_configuration_required')
  if (oauth !== undefined && (typeof signup !== 'function' || typeof oauth.readAuthorization !== 'function' || typeof oauth.approve !== 'function' || typeof oauth.deny !== 'function')) throw new Error('oauth_connector_configuration_required')
  if (listAccountGrants !== undefined && typeof listAccountGrants !== 'function') throw new Error('account_signup_configuration_required')
  if (legacyAccount !== undefined && (typeof legacyAccount.candidate !== 'function' || typeof legacyAccount.confirm !== 'function')) throw new Error('legacy_account_configuration_required')
  if (selfClaims !== undefined && (typeof selfClaims.lookupSlug !== 'function' || typeof selfClaims.lookupName !== 'function' || typeof selfClaims.claimable !== 'function' || typeof selfClaims.claim !== 'function')) throw new Error('self_claims_configuration_required')
  const invitationMode = typeof claimInvitation === 'function' && typeof signup !== 'function'
  const authorizationOrigin = login.authorizationOrigin ?? null
  if (invitationMode && authorizationOrigin === null) throw new Error('explicit_private_authorization_origin_required')
  if (authorizationOrigin !== null) {
    const authorization = new URL(authorizationOrigin)
    if (authorization.protocol !== 'https:' || authorization.origin !== authorizationOrigin) throw new Error('explicit_private_authorization_origin_required')
  }
  const pending = new Map(), invitations = new Map(), confirmations = new Map(), sessions = new Map()
  let invitationWindow = 0, invitationRequests = 0, contactWindow = 0, contactRequests = 0, unsubscribeWindow = 0, unsubscribeRequests = 0
  // A member stays signed in on this browser until they sign out or the runtime restarts.
  const SESSION_SECONDS = 30 * 24 * 60 * 60, SESSION_CAPACITY = 5000
  // Pages a sign-in may return to. Everything else lands on the home route.
  // An OAuth connector authorization request returns to its own validated
  // consent page (the query is re-validated there, never trusted).
  const returnPath = value => typeof value === 'string' && (/^\/(?:profile|card|settings|import|network|invites|invitations|notifications|notifications\/[0-9a-f-]{36}|people\/add|i\/[A-Za-z0-9_-]{43}|people\/[A-Za-z0-9._~%-]{1,480})$/.test(value) || (oauth && /^\/oauth\/authorize\?[\x21-\x7e]{1,6000}$/.test(value))) ? value : null
  const extend = (view, addition) => { view.content = view.content.includes('</main>') ? view.content.replace('</main>', `${addition}</main>`) : view.content + addition; return view }
  let uploadBusy = false
  const publicReader = createPublicPeopleReader({ readPublishedSnapshot })
  // An own connection links to the published profile of the same person when one
  // exists: a recovered legacy edge names it, and a public-consent import row is
  // published as public-<row id>. Private-only rows stay plain text.
  const contactRow = row => ({ name: [row.fields['first name'], row.fields['last name']].filter(Boolean).join(' '), headline: row.fields.position, company: row.fields.company, linkedinUrl: row.fields.url })
  const publicTarget = row => ['recovered-legacy-public-v1', 'unlinked-invite', 'unlinked-connection'].includes(row.provenance?.source) && typeof row.provenance.toId === 'string' ? row.provenance.toId : typeof row.id === 'string' && /^[a-f0-9]{64}$/.test(row.id) ? 'public-' + row.id : null
  const usableTarget = id => id && id.length <= 160 && id !== '.' && id !== '..' ? id : null
  async function contactRows(rows, reader = publicReader) {
    const plainRows = rows.map(contactRow)
    if (typeof readPublishedSnapshot !== 'function' || !rows.length) return plainRows
    try {
      // One malformed source ID must not stop the rest of the page from linking.
      const matches = await publishedPeopleFor(rows, { publicTarget: row => usableTarget(publicTarget(row)), lookupSlug: selfClaims ? slug => selfClaims.lookupSlug(slug) : null, lookup: ids => reader.lookup({ ids }) })
      return plainRows.map((value, index) => {
        const match = matches[index]
        return match ? { ...value, id: match.id, ...(match.presence ? { presence: match.presence, connectionCount: match.connectionCount } : {}) } : value
      })
    } catch { return plainRows }
  }
  // One reader per page view: every read of the index on that page shares one build.
  const pageReader = () => createPublicPeopleReader({ readPublishedSnapshot, reuse: true })
  // The published profiles an account is connected to, once each: its own
  // network rows that link to a public profile (imported connections,
  // accepted invites and connection requests) plus everyone the public graph
  // connects to its own profile. Its own profile is never listed.
  async function connectedProfiles(owner, network, reader) {
    const targets = [...new Set(network.assertions.filter(row => row.category === 'connections').map(publicTarget).map(usableTarget).filter(Boolean))]
    const mine = typeof ownProfileId === 'function' ? await ownProfileId(owner).catch(() => null) : null
    const found = new Map()
    for (let start = 0; start < targets.length; start += 1000) for (const summary of (await reader.lookup({ ids: targets.slice(start, start + 1000) })).values()) found.set(summary.id, summary)
    if (mine) {
      for (const summary of await reader.neighbors({ id: mine })) found.set(summary.id, summary)
      const self = (await reader.lookup({ ids: [mine] })).get(mine)
      found.delete(mine); if (self) found.delete(self.id)
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  let publicRequests = 0, publicWindow = Date.now(), publicBusy = 0
  // Visitors can ask the AI about the public list. Each ask is a paid model call, so it is
  // bounded per minute, per day and in flight, for the whole site rather than per visitor.
  const ASK_PER_MINUTE = 12, ASK_PER_DAY = 1500, ASK_IN_FLIGHT = 2
  let askMinute = Date.now(), askMinuteCount = 0, askDay = Math.floor(Date.now() / 86400000), askDayCount = 0, askBusy = 0
  const publicAi = typeof complete === 'function' && typeof readPublishedSnapshot === 'function'
  const render = (response, title, content, status = 200) => page(response, title,
    (dataMode === 'synthetic' ? '<p><strong>Synthetic rehearsal only. Do not upload a personal archive.</strong></p>' : '') + content, status)
  function purge(map) { for (const [id, value] of map) if (value.expiresAt <= Date.now()) map.delete(id) }
  const sessionFor = request => { purge(sessions); return sessions.get(cookies(request)['__Host-ul-session']) }
  const redirect = (response, location) => { response.writeHead(303, { Location: location }); response.end() }
  const normalizedName = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : ''
  const hidden = (session, id) => `<input type="hidden" name="csrf" value="${html(session.csrf)}"><input type="hidden" name="importId" value="${html(id)}">`
  const recordAudit = async event => { try { await audit({ ...event, at: new Date().toISOString(), origin: base.origin }) } catch { /* Audit availability never changes identity authority. */ } }
  // The signed-in reader of each in-flight response, so every page's Me menu can
  // show the headline once this session has read the member's profile.
  const readers = new WeakMap()
  // Live header counts (My Network, the bell) for this response, when the
  // request is a signed-in page view; read once per request.
  const responseAlerts = new WeakMap()
  // Both counts in parallel, each bounded: a slow graph costs a badge, never the page.
  const bounded = (work, fallback) => Promise.race([Promise.resolve().then(work).catch(() => fallback), new Promise(resolve => setTimeout(resolve, 800, fallback).unref?.())])
  const readAlerts = async owner => {
    if (!memberConnections && !notifications) return null
    const [network, unseen] = await Promise.all([memberConnections ? bounded(() => memberConnections.pendingCount(owner), 0) : undefined, notifications ? bounded(() => notifications.counts(owner).then(value => value.unseen), 0) : undefined])
    return { ...(memberConnections ? { network } : {}), ...(notifications ? { notifications: unseen } : {}) }
  }
  const pageView = pathname => !pathname.startsWith('/api/') && !pathname.startsWith('/public-assets/') && !pathname.startsWith('/legacy-files/') && !/^\/notifications\/[^/]+$/.test(pathname) &&
    !/^\/imports\/[a-f0-9]{64}\/status$/.test(pathname) && !/\.[a-z]+$/i.test(pathname) && !['/login', '/logout', '/export', '/auth/callback/ideaflow'].includes(pathname)
  const journey = (response, view, job = null, script = '', status = 200) => {
    view = { ...view, content: fillNavAlerts(view.content, responseAlerts.get(response)) }
    const nonce = token()
    // manifest-src/worker-src cover exactly the same-origin PWA manifest and the
    // static-only service worker; everything else stays locked to 'none'. The
    // scan sheet (view.camera) adds exactly what /meet's camera scanner needs.
    const camera = view.camera === true
    // A consent form's POST redirects to the app's verified callback, and
    // browsers apply form-action to every hop of that redirect chain (the
    // app's callback may redirect again). The consent page renders no
    // attacker-controlled markup, so it allows https: hops, or the exact
    // loopback origin for an app on this computer.
    const formAction = typeof view.formAction === 'string' && /^(?:https:|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/.test(view.formAction) ? ` ${view.formAction}` : ''
    response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src ${camera ? "'self' " : ''}'nonce-${nonce}'; connect-src 'self'; img-src 'self'${camera ? ' blob:; media-src \'self\' blob:' : ''}; manifest-src 'self'; worker-src 'self'; form-action 'self'${formAction}; base-uri 'none'; frame-ancestors 'none'`)
    if (camera) response.setHeader('Permissions-Policy', 'camera=(self), microphone=()')
    script = `${TOP_BAR_SCRIPT}${script}`
    if (job && ['uploaded', 'parsing', 'indexing'].includes(job.status)) script += `;let timer=setInterval(async()=>{try{const r=await fetch(${JSON.stringify(job.statusUrl)},{credentials:'same-origin'});if(!r.ok){clearInterval(timer);return}const j=await r.json();const el=document.querySelector('.import-status');if(el){el.textContent='Importing'+(j.total===null?'':' · '+Math.floor(j.processed*100/Math.max(1,j.total))+'% · '+j.processed+' of '+j.total)}if(['indexed','partial','failed'].includes(j.status)||(!${JSON.stringify(job.profileReady)}&&j.profileReady)){clearInterval(timer);location.reload()}}catch{}},2000);`
    script = `${script};if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}`
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#4349c4"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><title>${html(view.title)} · Unlinked</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/app-icon-192.png"><link rel="icon" href="/app-icon-192.png" type="image/png"><link rel="stylesheet" href="${ONBOARDING_FONT_HREF}">${dataMode === 'synthetic' ? '<p>Synthetic rehearsal only. Do not upload a personal archive.</p>' : ''}${fillMeHeadline(view.content, readers.get(response)?.headline)}<script nonce="${nonce}">${script}</script>${camera ? `<script nonce="${nonce}" src="/public-assets/jsqr.js"></script><script nonce="${nonce}" type="module">${MEET_SCRIPT}${SCAN_TABS_SCRIPT}</script>` : ''}</html>`)
  }
  const displayIdentity = identity => identity.verifiedEmail ? html(identity.verifiedEmail) : `${html(identity.issuer)} / ${html(identity.subject)}`
  async function establishSession(response, identity, invitationToken = null, next = null) {
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
    let newOwner = false
    if (!owner && !invitationToken && typeof signup === 'function') {
      const provisioned = await signup({ issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId,
        verifiedAt: identity.verifiedAt, provenanceReceiptId: identity.provenanceReceiptId, newProfileIntent: true })
      owner = await resolveOwner(identity)
      if (!provisioned || provisioned.ownerId !== owner?.ownerId || provisioned.userId !== owner?.userId) throw new Error('private_owner_recovery_required')
      newOwner = true
    }
    if (!owner || typeof owner.ownerId !== 'string' || !owner.ownerId || typeof owner.userId !== 'string' || !owner.userId) throw new Error('private_owner_recovery_required')
    if (claimed && (claimed.ownerId !== owner.ownerId || claimed.userId !== owner.userId)) throw new Error('private_owner_recovery_required')
    purge(sessions)
    if (sessions.size >= SESSION_CAPACITY) throw new Error('private_login_capacity')
    const sessionId = token()
    const legacyProof = identity.verifiedEmail && identity.emailEvidence === 'signed-ideaflow-beta-v1' ? Object.freeze({ issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId, verifiedAt: identity.verifiedAt, email: identity.verifiedEmail, emailEvidence: identity.emailEvidence, ownerId: owner.ownerId, userId: owner.userId }) : null
    const legacyCandidate = legacyProof && legacyAccount ? await legacyAccount.candidate(legacyProof) : null
    // A lookup-hint claim identity: the hash mirrors the manifest's email
    // formula so a later seeded row for the same address collides cleanly.
    const selfClaim = selfClaims && !legacyCandidate ? { emailHash: createHash('sha256').update((identity.verifiedEmail ?? `subject-v1:${identity.issuer}/${identity.subject}`).normalize('NFKC').toLowerCase()).digest('hex'), identity: Object.freeze({ issuer: identity.issuer, subject: identity.subject }), candidate: null } : null
    const accountLabel = identity.verifiedEmail ?? identity.subject
    // The sign-in address, kept privately for notification emails and invite Reply-To while email is on.
    if (memberEmail?.sending && (identity.verifiedEmail || newOwner)) await bounded(() => memberEmail.rememberAddress(owner, { address: identity.verifiedEmail, verified: identity.providerEmailVerified === true, newAccount: newOwner }), false)
    const displayName = identity.displayName ?? identity.verifiedEmail ?? identity.subject
    const csrf = token()
    const expiresAt = Date.now() + SESSION_SECONDS * 1000
    sessions.set(sessionId, { legacyProof, legacyCandidate: legacyCandidate?.linked ? null : legacyCandidate, selfClaim, owner: Object.freeze({ ownerId: owner.ownerId, userId: owner.userId }), accountLabel, displayName, csrf, expiresAt })
    if (sessionStore) {
      try { await sessionStore.put(createHash('sha256').update(sessionId).digest('hex'), { ownerId: owner.ownerId, userId: owner.userId, accountLabel, displayName, csrf, expiresAt, createdAt: Date.now() }) } catch { }
    }
    response.setHeader('Set-Cookie', [cookie('__Host-ul-login', '', 0), cookie('__Host-ul-confirm', '', 0), cookie('__Host-ul-session', sessionId, SESSION_SECONDS)])
    await recordAudit({ event: 'auth_session_created', ownerHash: createHash('sha256').update(owner.ownerId).digest('hex') })
    // An invitation link someone signed in to answer comes first; its page then
    // continues to the old-account or find-me step when there is one.
    const invitation = returnPath(next)?.startsWith('/i/') || returnPath(next)?.startsWith('/oauth/authorize?') ? returnPath(next) : null
    redirect(response, invitation ?? (legacyCandidate && !legacyCandidate.linked ? '/legacy-account' : newOwner && selfClaim ? '/find-me' : returnPath(next) ?? '/'))
  }
  // Connect rules shared with agent write tools (connection-actions.mjs).
  const connectionActions = memberConnections ? createConnectionActions({ memberConnections, accountForProfile, ownProfileId, memberInvitations, readPublishedSnapshot }) : null
  // A People listing a Connect/answer/withdraw/remove form may return to: the
  // /network path with only its own filter parameters (a stale notice is dropped).
  const NETWORK_RETURN_KEYS = ['q', 'mode', 'presence', 'connected', 'scope', 'cursor', 'page']
  const networkReturn = value => {
    if (typeof value !== 'string' || value.length > 1200 || !/^\/network(?:\?[\x21-\x7e]*)?$/.test(value) || value.includes('#')) return null
    const url = new URL(value, base)
    if ([...url.searchParams.keys()].some(key => !NETWORK_RETURN_KEYS.includes(key) && key !== 'notice')) return null
    url.searchParams.delete('notice')
    return url
  }
  // Where a Connect/answer/withdraw/remove form returns, with a whitelisted notice code.
  const afterConnection = (next, code) => {
    if (typeof next === 'string' && /^\/people\/[A-Za-z0-9._~%-]{1,480}$/.test(next)) return `${next}?connect=${encodeURIComponent(code)}`
    const listing = networkReturn(next)
    if (listing) { listing.searchParams.set('notice', code); return `${listing.pathname}${listing.search}` }
    if (next === '/notifications') return '/notifications'
    return `/invitations?${next === '/invitations?tab=sent' ? 'tab=sent&' : ''}notice=${encodeURIComponent(code)}`
  }
  // AI picks are a POST result; their row forms return to the plain listing for the same words.
  const searchReturn = query => typeof query === 'string' && query.trim() && query.length <= 200 ? `/network?q=${encodeURIComponent(query.trim())}` : '/network'
  // Connect controls for listing rows: members get their relation (one batched
  // read), imported profiles not on Unlinked yet get an invite link.
  const withConnect = async (owner, rows, reader) => {
    if (!connectionActions || !Array.isArray(rows) || !rows.length) return rows
    const members = rows.filter(row => row?.id && row.presence === 'member').map(row => row.id)
    const relations = await connectionActions.relations(owner, members, { reader }).catch(() => new Map())
    return rows.map(row => !row?.id ? row
      : row.presence === 'member' && relations.has(row.id) ? { ...row, connect: relations.get(row.id) }
        : row.presence === 'shadow' && memberInvitations ? { ...row, connect: { state: 'invite' } } : row)
  }
  const notificationTarget = item => item.kind === 'connection_request_received' ? '/invitations'
    : item.actorProfileId ? `/people/${encodeURIComponent(item.actorProfileId)}` : item.kind === 'invite_accepted' ? '/invites' : '/network'
  // OAuth connector consent (mcp-server/oauth-server.mjs). GET validates the
  // request and shows consent (signing in first when needed); POST carries the
  // same parameters plus the session CSRF token and re-validates everything.
  async function authorizeConnector(request, response, url, session, chrome) {
    let params = url.searchParams, decision = null, access = 'read'
    if (request.method === 'POST') {
      const input = new URLSearchParams((await body(request, 16384)).toString('utf8'))
      if (!session || input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('decision').length !== 1 || input.getAll('access').length > 1) throw new Error('private_browser_csrf')
      decision = input.get('decision')
      access = input.get('access') ?? 'read'
      if (!['allow', 'deny'].includes(decision) || !['read', 'connections'].includes(access)) throw new Error('private_browser_csrf')
      params = new URLSearchParams([...input].filter(([key]) => !['csrf', 'decision', 'access'].includes(key)))
    } else if (request.method !== 'GET') { response.writeHead(405).end(); return }
    const result = await oauth.readAuthorization(params)
    if (!result.ok) {
      if (result.redirect) { redirect(response, result.redirect); return }
      journey(response, renderConnectorError({ ...chrome, message: result.message }), null, '', 400); return
    }
    if (!session) {
      const next = `/oauth/authorize?${params}`
      redirect(response, returnPath(next) ? `/login?next=${encodeURIComponent(next)}` : '/login'); return
    }
    // Connection actions are offered only where the runtime can carry them out,
    // and only ever as an explicit choice that starts off.
    const offerConnections = connectionActionsAvailable && result.request.connectionsAvailable === true
    if (decision === null) { journey(response, renderConnectorConsent({ ...chrome, request: result.request, offerConnections })); return }
    if (access === 'connections' && !offerConnections) throw new Error('private_browser_csrf')
    const ownerHash = createHash('sha256').update(session.owner.ownerId).digest('hex')
    if (decision === 'deny') { await recordAudit({ event: 'oauth_connection_denied', app: result.request.app, ownerHash }); redirect(response, oauth.deny(result.request)); return }
    const location = oauth.approve(result.request, session.owner, { connections: access === 'connections' })
    await recordAudit({ event: 'oauth_connection_approved', app: result.request.app, ownerHash, access })
    response.setHeader('Referrer-Policy', 'no-referrer')
    redirect(response, location)
  }
  // Agents may send and answer connection requests only where the runtime has
  // both the People index and connection requests, and only by explicit opt-in.
  const connectionActionsAvailable = Boolean(memberConnections) && typeof readPublishedSnapshot === 'function'
  // What the copyable setup can do, and which current tools it lacks.
  const setupAccess = grant => ({ scope: grant.scope, missingTools: missingAccountGrantTools(grant) })
  // Connected apps carry whether they predate tools their scope now has.
  const settingsGrants = grants => grants.map(grant => grant.connection ? { ...grant, outdated: missingAccountGrantTools(grant).length > 0 } : grant)
  // Settings grant listing: labels for OAuth-connected apps when available.
  const grantList = async (owner, backend) => typeof listAccountGrants === 'function' ? await listAccountGrants(owner) : (await backend.listAccountGrantIds()).map(id => ({ id }))
  const connector = oauth && mcpEndpoint ? { url: mcpEndpoint } : undefined
  // The invite form says where replies go: the member's own verified address.
  const inviteEmailProps = async owner => memberEmail?.sending ? { emailInvites: true, replyAddress: (await bounded(() => memberEmail.settings(owner), null))?.address ?? null } : { emailInvites: false }
  let lastPrune = Date.now()
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'strict-origin')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    if (request.headers.host !== base.host) { response.writeHead(403).end(); return }
    if (!['GET', 'POST'].includes(request.method) && !(request.method === 'HEAD' && isPublicDiscoveryPath(new URL(request.url, base).pathname))) { response.writeHead(405).end(); return }
    // RFC 8058 one-click unsubscribe is posted by mail providers, without this
    // origin; its signed token is the whole authority and it only turns email off.
    const oneClick = request.method === 'POST' && memberEmail && new URL(request.url, base).pathname === '/email/unsubscribe'
    if (request.method === 'POST' && !oneClick && request.headers.origin !== base.origin) { response.writeHead(403).end(); return }
    try {
      const url = new URL(request.url, base)
      if (url.origin !== base.origin) { response.writeHead(403).end(); return }

      if (sessionStore) {
        const sid = cookies(request)['__Host-ul-session']
        if (sid) {
          purge(sessions)
          if (!sessions.has(sid)) {
            try {
              const hash = createHash('sha256').update(sid).digest('hex')
              const record = await sessionStore.get(hash, Date.now())
              if (record) {
                sessions.set(sid, {
                  legacyProof: null,
                  legacyCandidate: null,
                  selfClaim: null,
                  owner: Object.freeze({ ownerId: record.ownerId, userId: record.userId }),
                  accountLabel: record.accountLabel,
                  displayName: record.displayName,
                  csrf: record.csrf,
                  expiresAt: record.expiresAt
                })
              }
            } catch { }
          }
        }
        if (Date.now() - lastPrune > 3600000) {
          lastPrune = Date.now()
          sessionStore.prune(Date.now()).catch(() => {})
        }
      }

      const viewer = sessionFor(request)
      if (viewer) readers.set(response, viewer)
      if (viewer && request.method === 'GET' && pageView(url.pathname)) { const alerts = await readAlerts(viewer.owner); if (alerts) responseAlerts.set(response, alerts) }
      const chrome = viewer ? { accountLabel: viewer.accountLabel, displayName: viewer.displayName, csrf: viewer.csrf, headline: viewer.headline, ...(responseAlerts.has(response) ? { alerts: responseAlerts.get(response) } : {}) } : {}
      if (await servePublicDiscovery(request, response, url.pathname, chrome)) return
      const invitationLink = url.pathname.match(/^\/i\/([A-Za-z0-9_-]{43})$/)
      if (request.method === 'GET' && invitationLink && memberInvitations && signup) {
        if (Date.now() - invitationWindow >= 60000) { invitationWindow = Date.now(); invitationRequests = 0 }
        if (++invitationRequests > 60) { response.writeHead(429, { 'Retry-After': '10' }).end(); return }
        response.setHeader('Referrer-Policy', 'no-referrer')
        const invitation = await memberInvitations.open(invitationLink[1])
        journey(response, renderInviteLanding({ ...chrome, token: invitationLink[1], invitation }), null, '', invitation ? 200 : 404); return
      }
      // Unsubscribe links from emails: no sign-in. GET only shows a confirm
      // button (link scanners must not unsubscribe anyone); POST, from that
      // button or a mail provider's one-click, turns the email off.
      if (memberEmail && url.pathname === '/email/unsubscribe' && ['GET', 'POST'].includes(request.method)) {
        if (Date.now() - unsubscribeWindow >= 60000) { unsubscribeWindow = Date.now(); unsubscribeRequests = 0 }
        if (++unsubscribeRequests > 600) { response.writeHead(429, { 'Retry-After': '10' }).end(); return }
        response.setHeader('Referrer-Policy', 'no-referrer')
        response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
        let token = url.searchParams.getAll('t').length === 1 ? url.searchParams.get('t') : null
        if (request.method === 'POST') {
          const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
          if ([...input.keys()].some(key => !['t', 'List-Unsubscribe'].includes(key)) || input.getAll('t').length > 1) throw new Error('email_unsubscribe_invalid')
          if (input.get('t')) token = input.get('t')
          const done = await memberEmail.unsubscribe(token)
          journey(response, renderEmailUnsubscribe({ ...chrome, state: done ? 'done' : 'invalid', scope: done?.scope, kinds: done?.kinds }), null, '', done ? 200 : 400); return
        }
        const value = memberEmail.inspectUnsubscribe(token)
        journey(response, renderEmailUnsubscribe({ ...chrome, state: value ? 'confirm' : 'invalid', token, scope: value?.scope, kinds: value?.kinds }), null, '', value ? 200 : 400); return
      }
      // A member's contact card, opened by the link or QR code they handed over.
      // Not indexed and never cached. The token is the only way in, and a reset
      // or hidden card answers as not found. The site-wide bound only protects
      // the graph from load; an unguessable token needs no guessing limit.
      const contactLink = url.pathname.match(/^\/c\/([0-9A-Za-z]{24})(\/contact\.vcf)?$/)
      if (request.method === 'GET' && contactLink && contactCards && signup) {
        if (Date.now() - contactWindow >= 60000) { contactWindow = Date.now(); contactRequests = 0 }
        if (++contactRequests > 1200) { response.writeHead(429, { 'Retry-After': '10' }).end(); return }
        response.setHeader('Referrer-Policy', 'no-referrer')
        response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
        const card = await contactCards.open(contactLink[1])
        if (contactLink[2]) {
          if (!card) { response.writeHead(404).end(); return }
          response.writeHead(200, { 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': 'attachment; filename="contact.vcf"' })
          response.end(renderContactVcard(card, base.origin)); return
        }
        journey(response, renderContactCard({ ...chrome, card, token: contactLink[1] }), null, '', card ? 200 : 404); return
      }
      const publicDetail = url.pathname.match(/^\/api\/people\/([^/]+)$/)
      const publicProfile = url.pathname.match(/^\/people\/([^/]+)$/)
      const publicCompanyApi = url.pathname.match(/^\/api\/companies\/([^/]+)$/)
      const publicCompany = url.pathname.match(/^\/companies\/([^/]+)$/)
      if (request.method === 'GET' && url.pathname === '/people' && viewer) { redirect(response, `/network${url.search}`); return }
      if (request.method === 'GET' && (url.pathname === '/api/people' || publicDetail || publicProfile || publicCompanyApi || publicCompany || url.pathname === '/people' || (url.pathname === '/network' && !viewer))) {
        if (Date.now() - publicWindow >= 60000) { publicWindow = Date.now(); publicRequests = 0 }
        if (++publicRequests > 120 || publicBusy >= 2) { response.writeHead(429, { 'Retry-After': '10' }).end(); return }
        publicBusy++
        try {
          if (url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('mode').length > 1 || url.searchParams.getAll('presence').length > 1) throw new PublicPeopleReaderError(400, 'public_people_input_invalid')
          if (publicCompanyApi || publicCompany) {
            let name
            try { name = decodeURIComponent((publicCompanyApi ?? publicCompany)[1]) } catch { throw new PublicPeopleReaderError(400, 'public_people_input_invalid') }
            const result = await publicReader.company({ name, cursor: url.searchParams.get('cursor') ?? undefined })
            const facts = companyFacts(name)
            // A name nobody lists and we know nothing about is not a page.
            if (!result.total && !facts) { response.writeHead(404).end(); return }
            if (publicCompanyApi) { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ company: { ...result, ...(facts ? { facts } : {}) } })); return }
            journey(response, renderCompany({ ...chrome, ...result, name, facts })); return
          }
          if (publicDetail || publicProfile) {
            let id
            try { id = decodeURIComponent((publicDetail ?? publicProfile)[1]) } catch { throw new PublicPeopleReaderError(400, 'public_people_input_invalid') }
            const result = await publicReader.profile({ id, cursor: url.searchParams.get('cursor') ?? undefined })
            if (!result) { response.writeHead(404).end(); return }
            // A merged profile's old address moves to the profile it was merged into.
            if (result.moved) { response.writeHead(301, { Location: `${publicDetail ? '/api/people/' : '/people/'}${encodeURIComponent(result.moved)}`, 'Cache-Control': 'no-store' }).end(); return }
            if (publicDetail) { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return }
            // Connect: only members (an account stands behind the profile) can be asked.
            let connect
            if (memberConnections && signup) {
              if (result.profile.presence === 'member') connect = viewer ? await connectionActions.relationTo(viewer.owner, result.profile.id).catch(() => undefined) : { state: 'signed-out' }
              else if (viewer && result.profile.presence === 'shadow' && memberInvitations) connect = { state: 'invite' }
            }
            const notice = url.searchParams.get('connect')
            journey(response, renderPerson({ ...chrome, profile: result.profile, connect, connectNotice: connectNoticeCodes.includes(notice) ? notice : undefined })); return
          }
          const query = url.searchParams.get('q') ?? '', mode = url.searchParams.get('mode') ?? 'best', presence = url.searchParams.get('presence') ?? undefined
          const result = await publicReader.list({ query, mode, presence, cursor: url.searchParams.get('cursor') ?? undefined })
          if (url.pathname === '/api/people') { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)); return }
          const view = renderPeople({ ...chrome, scope: 'everyone', everyone: result.profiles, anonymousPublic: true, anonymousAi: publicAi, query, mode, presence, match: result.match, nextCursor: result.nextCursor, state: 'ready' })
          journey(response, view); return
        } catch (error) {
          const status = error instanceof PublicPeopleReaderError ? error.status : 503
          response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: status === 400 ? 'public_people_input_invalid' : 'public_people_unavailable' })); return
        } finally { publicBusy-- }
      }
      if (request.method === 'POST' && url.pathname === '/ask' && !viewer) {
        if (!publicAi) { response.writeHead(404).end(); return }
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        const query = input.get('query') ?? ''
        if (input.getAll('query').length !== 1 || !query.trim() || query.length > 200 || [...input.keys()].some(key => key !== 'query')) throw new Error('public_ask_input_invalid')
        // The ordinary list for the same words stays on the page beside the AI picks.
        let listed = {}
        try { const result = await publicReader.list({ query }); listed = { everyone: result.profiles, match: result.match, nextCursor: result.nextCursor } } catch { /* The AI picks stand alone when the list cannot be read. */ }
        const page = extra => renderPeople({ query, state: 'ready', anonymousAi: true, ...listed, ...extra })
        const now = Date.now(), day = Math.floor(now / 86400000)
        if (now - askMinute >= 60000) { askMinute = now; askMinuteCount = 0 }
        if (day !== askDay) { askDay = day; askDayCount = 0 }
        if (askMinuteCount >= ASK_PER_MINUTE || askDayCount >= ASK_PER_DAY || askBusy >= ASK_IN_FLIGHT) {
          response.setHeader('Retry-After', '60')
          journey(response, page({ aiError: 'AI search is busy right now. Try again in a minute; the regular results are below.' }), null, '', 429); return
        }
        askMinuteCount++; askDayCount++; askBusy++
        try {
          const controller = new AbortController()
          response.once('close', () => { if (!response.writableFinished) controller.abort() })
          const result = await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]) })
          journey(response, page({ aiMatches: result.matches, aiNote: `${result.considered.toLocaleString('en-US')} public profiles considered; ${result.modelCandidates} ranked with AI.` }))
        } catch {
          journey(response, page({ aiError: 'AI search could not finish. Try again; the regular results are below.' }), null, '', 503)
        } finally { askBusy-- }
        return
      }
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
        pending.set(id, { ...result.transaction, next: returnPath(url.searchParams.get('next')), expiresAt: Date.now() + 5 * 60000 })
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
        await establishSession(response, identity, null, transaction.next); return
      }
      if (oauth && url.pathname === '/oauth/authorize') { await authorizeConnector(request, response, url, viewer, chrome); return }
      const session = sessionFor(request)
      if (!session) {
        if (request.method === 'GET' && url.pathname === '/') journey(response, renderLanding())
        else if (request.method === 'GET' && url.pathname === '/join') journey(response, renderJoin())
        else if (request.method === 'GET' && url.pathname === '/scan') journey(response, renderScan({ tab: url.searchParams.get('tab') }))
        else if (request.method === 'GET') journey(response, renderSignInRequired({ next: returnPath(url.pathname) }), null, '', 401)
        else render(response, 'Sign in required', '<a class="action" href="/login">Sign in</a>', 401)
        return
      }
      if (request.method === 'GET' && url.pathname === '/join') { redirect(response, '/'); return }
      if (request.method === 'GET' && url.pathname === '/legacy-account') {
        if (!session.legacyCandidate) { redirect(response, '/profile'); return }
        render(response, 'Your existing Unlinked profile', `<p>This looks like your old Unlinked account. Continue?</p><small>Signed in as ${html(session.accountLabel)}</small><form method="post" action="/legacy-account"><input type="hidden" name="csrf" value="${html(session.csrf)}"><button name="action" value="confirm">Continue with my old profile</button><button name="action" value="skip">Continue without linking</button></form>`); return
      }
      if (request.method === 'POST' && url.pathname === '/legacy-account') {
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('action').length !== 1 || [...input.keys()].some(key => !['csrf','action'].includes(key))) throw new Error('private_browser_csrf')
        if (!session.legacyCandidate || !session.legacyProof || !legacyAccount) throw new Error('legacy_confirmation_unavailable')
        if (input.get('action') === 'confirm') {
          await legacyAccount.confirm(session.legacyProof, session.legacyCandidate.profileId, true)
          await recordAudit({ event: 'legacy_profile_confirmed', ownerHash: createHash('sha256').update(session.owner.ownerId).digest('hex') })
          if (typeof notifyProfileClaimed === 'function') void notifyProfileClaimed(session.legacyCandidate.profileId, session.owner).catch(() => {})
        } else if (input.get('action') !== 'skip') throw new Error('legacy_confirmation_required')
        session.legacyCandidate = null
        redirect(response, '/profile'); return
      }
      if (request.method === 'GET' && url.pathname === '/find-me') {
        if (!selfClaims || !session.selfClaim) { redirect(response, '/profile'); return }
        journey(response, renderFindMe({ accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf })); return
      }
      if (request.method === 'POST' && url.pathname === '/find-me') {
        if (!selfClaims || !session.selfClaim) { redirect(response, '/profile'); return }
        const input = new URLSearchParams((await body(request, 4096)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('linkedinUrl').length > 1 || [...input.keys()].some(key => !['csrf', 'linkedinUrl'].includes(key))) throw new Error('private_browser_csrf')
        const address = (input.get('linkedinUrl') ?? '').trim()
        if (address.length > 2048) throw new Error('self_claim_input_invalid')
        // One person finding themselves needs a handful of tries; a session
        // enumerating the private slug index does not.
        session.selfClaim.lookups = (session.selfClaim.lookups ?? 0) + 1
        if (session.selfClaim.lookups > 20) { response.writeHead(429, { 'Retry-After': '3600' }).end(); return }
        session.selfClaim.candidate = null
        const page = lookupResult => journey(response, renderFindMe({ accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf, lookupResult }))
        let profileId = null, evidence = null
        const slugMatch = address.match(/linkedin\.com\/in\/([^/?#]+)/i) ?? (/^[A-Za-z0-9%._-]{1,120}$/.test(address) ? [null, address] : null)
        if (address && slugMatch) {
          let slug = slugMatch[1]
          try { slug = decodeURIComponent(slug) } catch { /* use the raw segment */ }
          profileId = await selfClaims.lookupSlug(slug)
          evidence = 'self-asserted-linkedin-url-v1'
        }
        if (!profileId) {
          // The fallback name comes from the identity provider, never from a
          // typed field, and must match exactly one legacy profile; email and
          // bare-subject fallbacks never qualify.
          const wanted = normalizedName(session.displayName)
          if (wanted.includes(' ') && !wanted.includes('@')) {
            profileId = await selfClaims.lookupName(session.displayName)
            if (profileId) evidence = 'self-asserted-display-name-v1'
          }
        }
        if (profileId && await selfClaims.claimable(profileId)) {
          // A test profile has its own card; no public reader knows it.
          let detail = typeof selfClaims.preview === 'function' ? await selfClaims.preview(profileId) : null
          if (!detail) detail = await publicReader.profile({ id: profileId })
          // A merged-away profile is claimed through the profile it was merged into.
          if (detail?.moved) { profileId = detail.moved; detail = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId) && await selfClaims.claimable(profileId) ? await publicReader.profile({ id: profileId }) : null }
          if (detail?.profile) {
            // The confirmation is bound to this exact displayed candidate; a
            // newer lookup in another tab invalidates a stale card.
            session.selfClaim.candidate = { profileId, evidence, token: token() }
            page({ status: 'found', id: profileId, profileName: detail.profile.name, headline: detail.profile.headline ?? '', listedBy: detail.profile.connections.length, claimAction: '/claim-me', claimToken: session.selfClaim.candidate.token, ...(detail.test === true ? { test: true } : {}) }); return
          }
        }
        page({ status: 'none' }); return
      }
      if (request.method === 'POST' && url.pathname === '/claim-me') {
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('candidate').length !== 1 || [...input.keys()].some(key => !['csrf', 'candidate'].includes(key))) throw new Error('private_browser_csrf')
        if (!selfClaims || !session.selfClaim?.candidate || input.get('candidate') !== session.selfClaim.candidate.token) throw new Error('self_claim_unavailable')
        const { profileId, evidence } = session.selfClaim.candidate
        try {
          const claimed = await selfClaims.claim({ owner: session.owner, issuer: session.selfClaim.identity.issuer, subject: session.selfClaim.identity.subject, emailHash: session.selfClaim.emailHash, profileId, evidence })
          await recordAudit({ event: claimed.test === true ? 'test_profile_self_claimed' : 'legacy_profile_self_claimed', ownerHash: createHash('sha256').update(session.owner.ownerId).digest('hex'), profileId, evidence, receiptId: claimed.receiptId })
          if (typeof notifyProfileClaimed === 'function') void notifyProfileClaimed(profileId, session.owner).catch(() => {})
          session.selfClaim = null
          redirect(response, '/profile'); return
        } catch (error) {
          if (error.message !== 'self_claim_conflict') throw error
          if (session.selfClaim) session.selfClaim.candidate = null
          journey(response, renderFindMe({ accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf, notice: 'That profile can’t be claimed right now. If it’s yours, contact us.' })); return
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/my-connections') {
        try {
          if ([...url.searchParams.keys()].some(key => !['degree','q','cursor'].includes(key)) || ['degree','q','cursor'].some(key => url.searchParams.getAll(key).length > 1)) throw Error('known_connections_input_invalid')
          const result = await createKnownConnectionsReader({ owner: session.owner, getBackend, readPublishedSnapshot })({ degree: Number(url.searchParams.get('degree') ?? '1'), query: url.searchParams.get('q') ?? '', cursor: url.searchParams.get('cursor') ?? undefined, signal: AbortSignal.timeout(30000) })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (error) {
          const status = /input_invalid|cursor_invalid/.test(error.message) ? 400 : error.message === 'known_connections_anchor_unavailable' ? 409 : 503
          response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: status === 400 ? 'known_connections_input_invalid' : status === 409 ? 'known_connections_anchor_unavailable' : 'known_connections_unavailable' }))
        }
        return
      }
      const accountNav = `<nav><a href="/">Import</a> · <a href="/network">My network</a> · <a href="/settings">Agent setup & settings</a></nav><small>Signed in as ${html(session.accountLabel)}</small><form method="post" action="/logout"><input type="hidden" name="csrf" value="${html(session.csrf)}"><button>Sign out</button></form>`
      const backend = await getBackend(session.owner)
      if (!backend?.adapter || typeof backend.readResource !== 'function') throw new Error('private_backend_unavailable')
      const legacyFileMatch=url.pathname.match(/^\/legacy-files\/([a-f0-9-]{36})$/i)
      if(request.method==='GET'&&(url.pathname==='/api/legacy-files'||legacyFileMatch)){
        try{
          if(!backend.readLegacyFiles)throw Error('legacy_storage_not_found')
          if(legacyFileMatch){
            const bytes=await backend.readLegacyOriginal(legacyFileMatch[1])
            response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="legacy-${legacyFileMatch[1]}.csv"`});response.end(bytes)
          }else{const value=await backend.readLegacyFiles();response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({files:value?.objects??[]}))}
        }catch(error){response.writeHead(error.message==='legacy_storage_not_found'?404:503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'legacy_storage_unavailable'}))}
        return
      }
      const jobResources = async () => {
        const ids = signup ? await (backend.listImportJobIds ?? backend.listImportIds)() : []
        const resources = []
        for (let start = 0; start < ids.length; start += 8) resources.push(...await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id))))
        return resources.filter(resource => resource && !resource.deleted && resource.sourceOwnerId === session.owner.ownerId && resource.payload?.id === resource.sourceId && !resource.payload.kind && !resource.payload.receiptOf)
      }
      const profileJobs = jobs => jobs.filter(resource => resource.payload.origin?.kind !== ADDED_PERSON).sort((a, b) => {
        const key = resource => {
          if (resource.payload.backgroundVersion !== 'profile-first-v1') return [0, 0, resource.sourceId]
          if (!Number.isSafeInteger(resource.payload.createdAt)) throw new Error('private_import_created_at_invalid')
          return [1, resource.payload.createdAt, resource.sourceId]
        }
        const left = key(a), right = key(b)
        return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2])
      })
      const jobProps = jobs => {
        // A person added by hand is not an export: it never drives the import status.
        const ordered = jobs.filter(resource => resource.payload.origin?.kind !== ADDED_PERSON).sort((a, b) => (b.payload.createdAt ?? 0) - (a.payload.createdAt ?? 0))
        const active = ordered.find(resource => ['uploaded', 'parsing', 'indexing'].includes(resource.payload.status)) ?? ordered.find(resource => resource.payload.backgroundVersion)
        return { accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf, publicProfessionalSearch: dataMode === 'private_live' && typeof readPublishedSnapshot === 'function', importJob: active ? importJobStatus(active.payload) : undefined }
      }
      const summaries = jobs => jobs.map(({ sourceId, payload }) => ({ id: sourceId, filename: payload.origin?.kind === ADDED_PERSON ? `Added by you: ${payload.origin.label}` : payload.filename, sha256: payload.archiveSha256, status: payload.status, accepted: payload.counts?.accepted ?? 0, indexed: payload.counts?.indexed ?? 0, rejected: payload.counts?.rejected ?? 0, failedFiles: payload.counts?.failedFiles ?? 0, ...(payload.error ? { errorMessage: importErrorMessage(payload) } : {}), visibility: payload.consent?.version === PUBLIC_UPLOAD_CONSENT.version && payload.consent.publicProfessionalSearch === true ? 'public' : 'private' }))
      const statusMatch = url.pathname.match(/^\/imports\/([a-f0-9]{64})\/status$/)
      if (request.method === 'GET' && statusMatch) {
        const resource = await backend.readResource('import', statusMatch[1])
        if (!resource || resource.deleted || resource.sourceOwnerId !== session.owner.ownerId || resource.payload?.ownerId !== session.owner.ownerId || resource.payload.id !== statusMatch[1] || resource.payload.kind || resource.payload.receiptOf) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(importJobStatus(resource.payload))); return
      }
      if (request.method === 'GET' && (url.pathname === '/' || (signup && url.pathname === '/import'))) {
        if (signup) { const jobs = await jobResources(); if (url.pathname === '/' && jobs.length) { redirect(response, '/network'); return } const props = jobProps(jobs); journey(response, renderBringArchive({ ...props, limitBytes: LIMITS.archiveBytes, syntheticMode: dataMode === 'synthetic' }), props.importJob, uploadProgressScript()); return }
        const ids = signup ? await backend.listImportIds() : []
        const jobs = await Promise.all(ids.map(id => backend.readResource('import', id)))
        render(response, 'Import your LinkedIn archive', `${signup ? accountNav : ''}<p>Complete archive preferred. Connections-only ZIP or CSV also works. Re-uploading the same named archive returns its durable receipt.</p><form method="post" action="/upload" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${html(session.csrf)}"><label>LinkedIn export ZIP or CSV <input required type="file" name="archive" accept=".zip,.csv"></label><small>Maximum 64 MiB and 100,000 parser records. Larger imports fail explicitly and do not publish observations.</small><p>By importing, your profile and connections join your Unlinked network, searchable by you and by any agent you connect. Contact details stay private.</p>${dataMode === 'synthetic' ? '<label><input required type="checkbox" name="syntheticConsent" value="yes"> This file contains synthetic test data only.</label>' : ''}<button>Import archive</button></form>${signup ? `<h2>Your imports</h2>${jobs.filter(job => job && !job.deleted && job.sourceOwnerId === session.owner.ownerId).map(job => `<article><a href="/imports/${html(job.sourceId)}">${html(job.payload.filename)}</a><p>${html(job.payload.counts?.indexed ?? 0)} observations indexed</p></article>`).join('') || '<p>Your first upload will appear here.</p>'}` : ''}`)
        return
      }
      if (signup && request.method === 'GET' && url.pathname === '/profile') {
        const jobs = await jobResources(), props = jobProps(jobs)
        if (props.importJob && ['uploaded', 'parsing', 'indexing'].includes(props.importJob.status) && !props.importJob.profileReady) { journey(response, renderImporting(props), props.importJob); return }
        const profile = profileFromRows(await readOwnerProfileRows({ ownerId: session.owner.ownerId, jobs: profileJobs(jobs), backend }))
        if (!profile.name && typeof backend.readLegacyProfile === 'function') {
          const legacy = await backend.readLegacyProfile()
          if (legacy) Object.assign(profile, legacy.profile)
        }
        session.headline = profile.headline
        const offerLookup = Boolean(selfClaims && session.selfClaim && !profile.name)
        let testClaim = null
        if (typeof backend.readTestProfileClaim === 'function') { try { testClaim = await backend.readTestProfileClaim() } catch { testClaim = null } }
        if (!profile.name) profile.name = session.displayName
        let contacts = [], connectionCount
        // Start reading the public index now; the contact lookup below joins it.
        const warming = typeof readPublishedSnapshot === 'function' ? publicReader.lookup({ ids: [] }).catch(() => null) : null
        try {
          const connections = (await createAccountNetwork({ owner: session.owner, getBackend }).readNetwork()).assertions.filter(row => row.category === 'connections')
          connectionCount = connections.length
          contacts = await contactRows(connections.slice(0, 10))
        } catch { /* The profile stands on its own while the network is still being read. */ }
        await warming
        journey(response, renderOwnProfile({ ...props, profile, contacts, connectionCount, imports: summaries(jobs), ...(testClaim ? { testClaim } : {}), ...(offerLookup ? { linkedinLookup: { action: '/find-me' } } : {}) }), props.importJob); return
      }
      // The member's own card identity and the public profile URL its QR opens.
      const readOwnCard = async jobs => {
        const profile = profileFromRows(await readOwnerProfileRows({ ownerId: session.owner.ownerId, jobs: profileJobs(jobs), backend }))
        let legacy = null
        if (typeof backend.readLegacyProfile === 'function') { try { legacy = await backend.readLegacyProfile() } catch { legacy = null } }
        if (!profile.name && legacy) Object.assign(profile, legacy.profile)
        if (!profile.name) profile.name = session.displayName
        // The QR target is the owner's already-public profile URL: the linked
        // legacy profile id when one is confirmed, else the newest public-
        // consent import that is actually in today's published snapshot (a
        // newer partial or not-yet-projected import never hides an older live
        // one). The code never encodes a private or dead target, and scanning
        // it grants nothing beyond what any visitor can already read.
        const candidates = legacy?.profileId ? [legacy.profileId] : []
        candidates.push(...jobs.filter(job => ['indexed', 'partial'].includes(job.payload.status) && job.payload.consent?.version === PUBLIC_UPLOAD_CONSENT.version && job.payload.consent.publicProfessionalSearch === true)
          .sort((a, b) => (b.payload.createdAt ?? 0) - (a.payload.createdAt ?? 0) || b.sourceId.localeCompare(a.sourceId))
          .map(job => 'member-import-' + job.sourceId))
        // Full RFC 3986 escaping so the target always matches the card grammar
        // that /meet scanning accepts (encodeURIComponent leaves !'()* alone).
        const profileHref = id => `/people/${encodeURIComponent(id).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}`
        let cardUrl = null, indexRead = true
        if (typeof readPublishedSnapshot === 'function') {
          for (const id of candidates.slice(0, 8)) {
            try { const found = await publicReader.profile({ id }); if (found) { cardUrl = new URL(profileHref(found.moved ?? id), base).href; break } }
            catch { indexRead = false; break /* The card still renders while the index is unavailable. */ }
          }
        }
        session.headline = profile.headline
        return { profile, cardUrl, identity: { name: profile.name, headline: profile.headline, location: profile.location, ...(indexRead ? { profilePath: cardUrl ? new URL(cardUrl).pathname : null } : {}) } }
      }
      // The contact version of the card, for its owner: the details, their show
      // switches, and the link and QR once something is shown.
      const ownContactCard = stored => {
        const shareUrl = stored?.card ? new URL(`/c/${stored.token}`, base).href : null
        return { settings: stored?.settings ?? {}, card: stored?.card ?? null, shareUrl, qr: shareUrl ? qrSvg(shareUrl, { label: 'QR code opening your contact card' }) : null }
      }
      if (signup && request.method === 'GET' && (url.pathname === '/card' || url.pathname === '/scan')) {
        const jobs = await jobResources(), props = jobProps(jobs)
        const { profile, cardUrl, identity } = await readOwnCard(jobs)
        const card = { ...props, profile, cardUrl, qr: cardUrl ? qrSvg(cardUrl, { label: `QR code opening ${cardUrl}` }) : null }
        if (url.pathname === '/scan') { journey(response, renderScan({ ...card, tab: url.searchParams.get('tab') }), props.importJob); return }
        let contact = null
        if (contactCards) {
          // The card still renders, without its contact version, while the graph is unavailable.
          try { await contactCards.syncIdentity(session.owner, identity); contact = ownContactCard(await contactCards.read(session.owner)) } catch { contact = null }
        }
        const notice = { saved: 'Saved.', reset: 'Your contact card has a new link. Earlier links and QR codes no longer work.' }[url.searchParams.get('done')]
        journey(response, renderCard({ ...card, contact, share: contact && url.searchParams.get('share') === 'contact' ? 'contact' : 'public', notice }), props.importJob); return
      }
      if (signup && contactCards && request.method === 'POST' && ['/card/contact', '/card/contact/reset'].includes(url.pathname)) {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        const fields = ['phone', 'whatsapp', 'email', 'link'], switches = ['showPhone', 'showWhatsapp', 'showEmail', 'showLink']
        const allowed = url.pathname === '/card/contact' ? ['csrf', ...fields, ...switches] : ['csrf']
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || allowed.some(key => input.getAll(key).length > 1) || [...input.keys()].some(key => !allowed.includes(key))) throw new Error('private_browser_csrf')
        const jobs = await jobResources(), props = jobProps(jobs)
        const { profile, cardUrl, identity } = await readOwnCard(jobs)
        const values = { ...Object.fromEntries(fields.map(key => [key, (input.get(key) ?? '').slice(0, 400)])), ...Object.fromEntries(switches.map(key => [key, input.get(key) === 'yes'])) }
        try {
          if (url.pathname === '/card/contact') await contactCards.save(session.owner, values, identity)
          else await contactCards.rotate(session.owner)
        } catch (failure) {
          if (!(failure instanceof ContactCardError)) throw failure
          const error = { contact_phone_invalid: 'Write your phone number with its country code, like +1 415 555 0123.', contact_whatsapp_invalid: 'Write your WhatsApp number with its country code, like +1 415 555 0123.',
            contact_email_invalid: 'That email address does not look right.', contact_link_invalid: 'Use a web address of up to 200 characters, like https://example.com.', contact_card_not_found: 'Add a contact detail first.' }[failure.code] ?? 'That did not work. Try again.'
          const contact = { ...ownContactCard(await contactCards.read(session.owner).catch(() => null)), ...(url.pathname === '/card/contact' ? { settings: values } : {}) }
          journey(response, renderCard({ ...props, profile, cardUrl, qr: null, contact, share: 'contact', error }), props.importJob, '', 400); return
        }
        redirect(response, `/card?share=contact&done=${url.pathname === '/card/contact' ? 'saved' : 'reset'}`); return
      }
      // Off-platform people: add someone to your own people, or invite them.
      if (signup && request.method === 'GET' && url.pathname === '/people/add') {
        const props = jobProps(await jobResources())
        journey(response, renderAddPerson(props), props.importJob); return
      }
      if (signup && request.method === 'POST' && url.pathname === '/people/add') {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        const keys = ['csrf', 'firstName', 'lastName', 'linkedinUrl', 'company', 'position']
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || keys.some(key => input.getAll(key).length > 1) || [...input.keys()].some(key => !keys.includes(key))) throw new Error('private_browser_csrf')
        const values = Object.fromEntries(keys.slice(1).map(key => [key, (input.get(key) ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()]))
        // A LinkedIn address is optional; when given it must be a LinkedIn profile.
        const address = values.linkedinUrl ? linkedinUrl(/^https?:\/\//i.test(values.linkedinUrl) ? values.linkedinUrl.replace(/^http:/i, 'https:') : `https://${values.linkedinUrl}`) : ''
        const problem = !values.firstName ? 'Add their name.'
          : ['firstName', 'lastName', 'company', 'position'].some(key => [...values[key]].length > 120 || /[\u0000-\u001f\u007f]/.test(values[key])) ? 'Keep each field under 120 characters.'
          : address === null ? 'Use a LinkedIn profile address, like https://www.linkedin.com/in/their-name, or leave it empty.' : null
        const props = jobProps(await jobResources())
        if (problem) { journey(response, renderAddPerson({ ...props, error: problem, values }), props.importJob, '', 400); return }
        // A one-row file in the shape of LinkedIn's export, kept private: never published.
        const cell = value => `"${value.replace(/"/g, '""')}"`
        const csv = `First Name,Last Name,URL,Email Address,Company,Position,Connected On\n${[values.firstName, values.lastName, address, '', values.company, values.position, ''].map(cell).join(',')}\n`
        await stageArchive({ ownerId: session.owner.ownerId, filename: 'Added people.csv', bytes: Buffer.from(csv, 'utf8'), adapter: backend.adapter, consent: COMBINED_UPLOAD_CONSENT, origin: { kind: ADDED_PERSON, label: [values.firstName, values.lastName].filter(Boolean).join(' ') } })
        redirect(response, '/network?added=1'); return
      }
      if (signup && memberInvitations && request.method === 'GET' && url.pathname === '/invites') {
        const props = jobProps(await jobResources())
        journey(response, renderInvites({ ...props, origin: base.origin, ...await inviteEmailProps(session.owner), invitations: await memberInvitations.list(session.owner) }), props.importJob); return
      }
      if (signup && memberInvitations && request.method === 'POST' && ['/invites', '/invites/revoke'].includes(url.pathname)) {
        const input = new URLSearchParams((await body(request, 4096)).toString('utf8'))
        const field = url.pathname === '/invites' ? 'inviteeName' : 'id'
        // The invitee's address is optional, used once to send, and never stored or shown again.
        const allowed = field === 'inviteeName' && memberEmail?.sending ? ['csrf', field, 'inviteeEmail'] : ['csrf', field]
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll(field).length !== 1 || input.getAll('inviteeEmail').length > 1 || [...input.keys()].some(key => !allowed.includes(key))) throw new Error('private_browser_csrf')
        const props = jobProps(await jobResources())
        const inviteeEmail = (input.get('inviteeEmail') ?? '').trim()
        let created, error, emailed
        try {
          if (field === 'inviteeName' && inviteeEmail && !emailAddress(inviteeEmail)) error = 'That email address does not look right. Nothing was created.'
          else if (field === 'inviteeName') {
            created = await memberInvitations.create({ inviter: session.owner, inviterName: session.displayName || session.accountLabel, inviteeName: input.get('inviteeName') })
            if (inviteeEmail) emailed = await memberEmail.sendInvite({ inviter: session.owner, inviterName: session.displayName, inviteeName: created.invitation.inviteeName, address: inviteeEmail, token: created.token, invitationId: created.invitation.id }).catch(() => ({ sent: false, reason: 'failed' }))
          }
          else await memberInvitations.revoke(session.owner, input.get('id'))
        } catch (failure) {
          if (!(failure instanceof InvitationError)) throw failure
          error = { invitation_name_invalid: 'Use a plain name of up to 120 characters.', invitation_unavailable: 'That invite can no longer be revoked.', invitation_not_found: 'That invite can no longer be revoked.' }[failure.code] ?? 'That did not work. Try again.'
        }
        response.setHeader('Cache-Control', 'no-store')
        journey(response, renderInvites({ ...props, origin: base.origin, created, error, emailed, ...await inviteEmailProps(session.owner), invitations: await memberInvitations.list(session.owner) }), props.importJob, '', error ? 400 : 200); return
      }
      // Member-to-member connection requests.
      if (signup && memberConnections && request.method === 'POST' && ['/connections/request', '/connections/respond', '/connections/withdraw', '/connections/remove'].includes(url.pathname)) {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        const fields = { '/connections/request': ['profileId', 'note', 'next'], '/connections/respond': ['id', 'action', 'next'], '/connections/withdraw': ['id', 'next'], '/connections/remove': ['id', 'next'] }[url.pathname]
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || fields.some(key => input.getAll(key).length > 1) || [...input.keys()].some(key => key !== 'csrf' && !fields.includes(key))) throw new Error('private_browser_csrf')
        if (url.pathname === '/connections/request') {
          if (input.getAll('profileId').length !== 1) throw new Error('private_browser_csrf')
          // The sender is named by their public profile when they have one, never by an email address.
          let outcome
          try { outcome = await connectionActions.send(session.owner, { profileId: input.get('profileId'), note: input.get('note') ?? undefined, fallbackName: session.displayName }) }
          catch (failure) { if (failure instanceof ConnectionError && failure.code === 'connection_profile_not_found') { response.writeHead(404).end(); return } throw failure }
          // A Connect button on a People row returns to that listing; the profile's own button to the profile.
          const listing = networkReturn(input.get('next'))
          redirect(response, afterConnection(listing ? input.get('next') : `/people/${encodeURIComponent(outcome.profileId)}`, outcome.code)); return
        }
        if (input.getAll('id').length !== 1) throw new Error('private_browser_csrf')
        let code
        try {
          if (url.pathname === '/connections/respond') { const action = input.get('action'); await memberConnections.respond(session.owner, input.get('id'), action); code = action === 'accept' ? 'accepted' : 'ignored' }
          else if (url.pathname === '/connections/remove') { await connectionActions.remove(session.owner, input.get('id')); code = 'removed' }
          else { await memberConnections.withdraw(session.owner, input.get('id')); code = 'withdrawn' }
        } catch (failure) { if (!(failure instanceof ConnectionError)) throw failure; code = failure.code === 'connection_action_invalid' ? 'connection_unavailable' : failure.code }
        redirect(response, afterConnection(input.get('next'), code)); return
      }
      if (signup && memberConnections && request.method === 'GET' && url.pathname === '/invitations') {
        if ([...url.searchParams.keys()].some(key => !['tab', 'notice'].includes(key))) { redirect(response, '/invitations'); return }
        const props = jobProps(await jobResources())
        const [received, sent] = await Promise.all([memberConnections.received(session.owner), memberConnections.sent(session.owner)])
        journey(response, renderInvitations({ ...props, tab: url.searchParams.get('tab') === 'sent' ? 'sent' : 'received', received, sent, notice: url.searchParams.get('notice') ?? undefined }), props.importJob); return
      }
      if (signup && notifications && request.method === 'GET' && url.pathname === '/notifications') {
        const props = jobProps(await jobResources())
        const items = await notifications.list(session.owner)
        const received = memberConnections ? await memberConnections.received(session.owner) : []
        // Opening the feed clears the bell; each item stays highlighted until opened.
        await notifications.markSeen(session.owner)
        const alerts = responseAlerts.get(response)
        if (alerts) responseAlerts.set(response, { ...alerts, notifications: 0 })
        journey(response, renderNotifications({ ...props, items, pending: new Map(received.map(value => [value.id, value])), pendingCount: received.length }), props.importJob); return
      }
      const notificationItem = url.pathname.match(/^\/notifications\/([0-9a-f-]{36})$/)
      if (signup && notifications && request.method === 'GET' && notificationItem) {
        const item = await notifications.open(session.owner, notificationItem[1])
        redirect(response, item ? notificationTarget(item) : '/notifications'); return
      }
      if (signup && notifications && request.method === 'POST' && url.pathname === '/notifications/read-all') {
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || [...input.keys()].some(key => key !== 'csrf')) throw new Error('private_browser_csrf')
        await notifications.markAllRead(session.owner)
        redirect(response, '/notifications'); return
      }
      const invitationAnswer = url.pathname.match(/^\/i\/([A-Za-z0-9_-]{43})$/)
      if (signup && memberInvitations && request.method === 'POST' && invitationAnswer && INVITATION_TOKEN.test(invitationAnswer[1])) {
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('action').length !== 1 || [...input.keys()].some(key => !['csrf', 'action'].includes(key))) throw new Error('private_browser_csrf')
        const invitation = await memberInvitations.open(invitationAnswer[1])
        const chromeProps = { accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf, token: invitationAnswer[1] }
        let outcome
        try { outcome = (await memberInvitations.respond(invitationAnswer[1], session.owner, input.get('action'), session.displayName || undefined)).status }
        catch (failure) {
          if (!(failure instanceof InvitationError)) throw failure
          journey(response, renderInviteLanding({ ...chromeProps, invitation: invitation ? { ...invitation, status: failure.code === 'invitation_own' ? 'own' : 'unavailable' } : null }), null, '', 409); return
        }
        const view = renderInviteLanding({ ...chromeProps, invitation, outcome })
        // After answering, continue to the old-account or find-me step when there is one.
        if (outcome === 'accepted' && (session.legacyCandidate || session.selfClaim)) view.content = view.content.replace('href="/profile"', `href="${session.legacyCandidate ? '/legacy-account' : '/find-me'}"`)
        journey(response, view); return
      }
      if (signup && request.method === 'GET' && url.pathname === '/network') {
        const network = await createAccountNetwork({ owner: session.owner, getBackend }).readNetwork()
        const connections = network.assertions.filter(row => row.category === 'connections')
        const typed = (url.searchParams.get('q') ?? '').trim(), filter = typed.toLowerCase()
        if (filter.length > 256) throw new Error('network_filter_limit')
        const mode = url.searchParams.get('mode') ?? 'best'
        if (!SEARCH_MODES.includes(mode) || url.searchParams.getAll('mode').length > 1) throw new Error('network_search_mode_invalid')
        const presence = url.searchParams.get('presence') ?? undefined
        if (url.searchParams.getAll('presence').length > 1 || (presence !== undefined && !PRESENCE.includes(presence))) throw new PublicPeopleReaderError(400, 'public_people_input_invalid')
        // "My connections" is deep-linkable: /network?presence=member&connected=1
        // lists the members (not imported shadows) this account is connected to.
        const connectedValues = url.searchParams.getAll('connected')
        if (connectedValues.length > 1 || (connectedValues.length && connectedValues[0] !== '1')) throw new PublicPeopleReaderError(400, 'public_people_input_invalid')
        const connectedOnly = connectedValues[0] === '1'
        // The same matching as the public list: every word in any form, else the closest people.
        const matcher = typed ? createQueryMatcher(typed, mode) : null
        const index = Number(url.searchParams.get('page') ?? '0')
        if (!Number.isSafeInteger(index) || index < 0 || index > 1000) throw new Error('network_page_limit')
        const props = jobProps(await jobResources()), reader = pageReader()
        const publicProfessionalSearch = typeof readPublishedSnapshot === 'function'
        // Row forms come back to this exact listing, with a notice.
        const listing = networkReturn(`${url.pathname}${url.search}`)
        const returnTo = listing ? `${listing.pathname}${listing.search}` : '/network'
        const notice = connectNoticeCodes.includes(url.searchParams.get('notice')) ? url.searchParams.get('notice') : undefined
        // Who this account is connected to, for the filter and its counts. A
        // failed read costs the filter, never the page.
        let mine = null
        if (publicProfessionalSearch) { try { mine = await connectedProfiles(session.owner, network, reader) } catch { mine = null } }
        const connectedCounts = mine ? { all: mine.length, member: mine.filter(value => value.presence === 'member').length, shadow: mine.filter(value => value.presence === 'shadow').length } : undefined
        if (connectedOnly) {
          const kept = (mine ?? []).filter(value => !presence || value.presence === presence)
          const ranked = matcher ? rankMatches(kept, matcher, value => ({ name: words(value.name), text: words([value.name, value.headline, value.location].filter(Boolean).join(' ')) })) : { rows: kept, match: 'none' }
          const rows = await withConnect(session.owner, ranked.rows.slice(index * 100, (index + 1) * 100), reader)
          const view = renderPeople({ ...props, query: typed, mode, presence, match: ranked.match, state: mine ? 'ready' : 'unavailable', returnTo, notice, connectedCounts,
            connectedView: { rows, total: ranked.rows.length, ...(ranked.rows.length > (index + 1) * 100 ? { nextPage: index + 1 } : {}) } })
          journey(response, view, props.importJob); return
        }
        const ownMatches = matcher ? rankMatches(connections, matcher, row => ({ name: words([row.fields['first name'], row.fields['last name']].filter(Boolean).join(' ')), text: words([row.fields['first name'], row.fields['last name'], row.fields.company, row.fields.position].filter(Boolean).join(' ')) })) : { rows: connections, match: 'none' }
        const rows = ownMatches.rows
        const linking = contactRows(rows.slice(index * 100, (index + 1) * 100), reader)
        let everyone, nextCursor, state = 'ready', match = ownMatches.match
        if (publicProfessionalSearch) {
          everyone = []
          try { const result = await reader.list({ query: filter, mode, presence, cursor: url.searchParams.get('cursor') ?? undefined }); everyone = result.profiles; nextCursor = result.nextCursor; if (result.match === 'all' || (result.match === 'some' && match !== 'all')) match = result.match }
          catch (error) { if (error instanceof PublicPeopleReaderError && error.status === 400) throw error; state = 'unavailable' }
        }
        const scope = publicProfessionalSearch ? url.searchParams.get('scope') ?? 'everyone' : 'own'
        if (!['everyone', 'own'].includes(scope)) throw new Error('shared_search_scope_invalid')
        // The contact lookup ran alongside the public list and shares its snapshot read.
        const contacts = await withConnect(session.owner, await linking, reader)
        everyone = await withConnect(session.owner, everyone, reader)
        const view = renderPeople({ ...props, scope, own: network.imports.length || network.legacyProfileId ? contacts : undefined, everyone, nextCursor, state, ...(!publicProfessionalSearch ? { contacts } : {}), query: typed, mode, presence, added: url.searchParams.get('added') === '1', match, returnTo, notice, connectedCounts })
        if (rows.length > (index + 1) * 100) extend(view, `<p class="dir"><a href="/network?page=${index + 1}&q=${encodeURIComponent(filter)}${mode === 'exact' ? '&mode=exact' : ''}">Next contacts</a></p>`)
        journey(response, view, props.importJob)
        return
      }
      if (signup && request.method === 'GET' && url.pathname === '/settings') {
        // The agent setup is prepared automatically: reuse the owner's live
        // grant or mint the one idempotent automatic grant. A revoked automatic
        // setup stays revoked (ensure returns null) until the owner regenerates.
        const ensured = typeof ensureAccountGrant === 'function' ? await ensureAccountGrant(session.owner) : null
        const configuration = ensured ? scopedSetupConfiguration({ endpoint: mcpEndpoint, accessToken: ensured.accessToken }) : null
        const setups = ensured ? agentClientSetups({ endpoint: mcpEndpoint, accessToken: ensured.accessToken }) : null
        const grants = await grantList(session.owner, backend)
        const jobs = await jobResources(), props = jobProps(jobs)
        // Email choices appear only while email is on; a slow read costs the section, never the page.
        const email = memberEmail?.sending ? await bounded(() => memberEmail.settings(session.owner), null) : null
        const view=renderSettings({ ...props, grants: settingsGrants(grants), imports: summaries(jobs), agentConfiguration: configuration, agentSetups: setups, agentSetupAutomatic: typeof ensureAccountGrant === 'function', connector, agentAccess: ensured ? setupAccess(ensured) : undefined, connectionActionsAvailable,
          ...(email ? { email: { ...email, labels: EMAIL_PREFERENCES, saved: url.searchParams.get('email') === 'saved' } } : {}) })
        const recovered=typeof backend.readLegacyFiles==='function'?await backend.readLegacyFiles():null
        if(recovered?.objects.length)extend(view,`<div class="narrow wide"><details><summary>Your recovered LinkedIn files (${recovered.objects.length})</summary><p>Original files stay private. Professional connection observations are included in your own network; other files and invalid records remain available here.</p>${recovered.objects.map(file=>`<p><a href="/legacy-files/${html(file.objectId)}">${html(file.filename)}</a> · ${html(file.bytes)} bytes · ${html(file.accepted)} professional records${file.error?' · preserved original; not indexed':''}</p>`).join('')}</details></div>`)
        journey(response,view,props.importJob,configuration||connector?agentSetupCopyScript():'')
        return
      }
      if (signup && memberEmail && request.method === 'POST' && url.pathname === '/settings/email') {
        const input = new URLSearchParams((await body(request, 2048)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || [...input.keys()].some(key => !['csrf', 'kinds'].includes(key)) || input.getAll('kinds').some(kind => !Object.hasOwn(EMAIL_PREFERENCES, kind))) throw new Error('private_browser_csrf')
        await memberEmail.savePreferences(session.owner, input.getAll('kinds'))
        redirect(response, '/settings?email=saved#email'); return
      }
      if (signup && request.method === 'GET' && url.pathname === '/export') {
        const jobs = await jobResources()
        const grants = await backend.listAccountGrantIds()
        const data = await exportAccountData({ owner: session.owner, backend, jobs, grants })
        data.account.accountLabel = session.accountLabel
        data.account.displayName = session.displayName
        // The contact card's details belong to the export; its link does not.
        if (contactCards) data.contactCard = await contactCards.exportOwner(session.owner).catch(() => null)
        if (memberEmail) data.email = await memberEmail.exportOwner(session.owner).catch(() => null)
        await recordAudit({ event: 'account_data_exported', ownerHash: createHash('sha256').update(session.owner.ownerId).digest('hex') })
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="unlinked-export-${new Date().toISOString().slice(0, 10)}.json"` })
        response.end(JSON.stringify(data, null, 2)); return
      }
      if (signup && request.method === 'POST' && url.pathname === '/delete-account') {
        const input = new URLSearchParams((await body(request, 8192)).toString('utf8'))
        if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || input.getAll('confirm').length > 1 || [...input.keys()].some(key => !['csrf', 'confirm'].includes(key))) throw new Error('private_browser_csrf')
        if ((input.get('confirm') ?? '').trim().toLowerCase() !== 'delete everything') {
          const jobs = await jobResources(), props = jobProps(jobs)
          journey(response, renderSettings({ ...props, grants: await grantList(session.owner, backend), imports: summaries(jobs), connector, deleteError: 'Type “delete everything” exactly to confirm. Nothing was deleted.' }), props.importJob, '', 400)
          return
        }
        const jobs = await jobResources()
        const grantIds = await backend.listAccountGrantIds()
        // Invitations hold names the owner typed: they go with the account.
        if (memberInvitations) await memberInvitations.removeOwner(session.owner)
        // The contact card goes first: its link must never outlive the account.
        if (contactCards) await contactCards.removeOwner(session.owner)
        const result = await deleteAccountData({ owner: session.owner, backend, jobs, grantIds })
        // Connection requests either way, and notifications to or about this account.
        if (memberConnections) await memberConnections.removeOwner(session.owner)
        if (notifications) await notifications.removeOwner(session.owner)
        // The stored sign-in address, email choices and invite-send counters.
        if (memberEmail) await memberEmail.removeOwner(session.owner)
        // Best effort beyond the graph: the legacy claim and the stored archive bytes.
        if (typeof revokeLegacyLink === 'function') await revokeLegacyLink(session.owner).catch(() => {})
        if (typeof removeOwnerAssets === 'function') await removeOwnerAssets(session.owner.ownerId).catch(() => {})
        for (const [id, value] of sessions) if (value.owner.ownerId === session.owner.ownerId) sessions.delete(id)
        if (sessionStore) await sessionStore.deleteOwner(session.owner.ownerId).catch(() => {})
        response.setHeader('Set-Cookie', cookie('__Host-ul-session', '', 0))
        await recordAudit({ event: 'account_data_deleted', ownerHash: createHash('sha256').update(session.owner.ownerId).digest('hex'), deletedResources: result.deletedResources })
        journey(response, renderDataDeleted())
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
          if (input.getAll('scope').length > 2 || input.getAll('scope').some(value => !['everyone','own'].includes(value))) throw new Error('shared_search_scope_invalid')
          const publicProfessionalSearch = typeof readPublishedSnapshot === 'function'
          const scope = publicProfessionalSearch ? input.getAll('scope').at(-1) ?? 'everyone' : 'own'
          if (!['everyone', 'own'].includes(scope)) throw new Error('shared_search_scope_invalid')
          if (scope === 'everyone') {
            const result = await createSharedPeopleSearch({ readPublishedSnapshot, complete })({ query: input.get('query'), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]) })
            const props = jobProps(await jobResources()), network = await createAccountNetwork({ owner: session.owner, getBackend }).readNetwork()
            const reader = pageReader()
            const own = network.imports.length || network.legacyProfileId ? await withConnect(session.owner, await contactRows(network.assertions.filter(row => row.category === 'connections').slice(0, 100), reader), reader) : undefined
            const aiMatches = await withConnect(session.owner, result.matches, reader)
            const view = renderPeople({ ...props, scope, aiMatches, aiNote: `${result.considered.toLocaleString('en-US')} public profiles considered; ${result.modelCandidates} ranked with AI.`, own, query: input.get('query'), state: 'ready', returnTo: searchReturn(input.get('query')) })
            journey(response, view, props.importJob); return
          }
          const account = createAccountNetwork({ owner: session.owner, getBackend, complete })
          const result = await account.search({ query: input.get('query'), signal: controller.signal })
          const props = jobProps(await jobResources())
          // Picks carry only the assertion; its source row says where the public profile is.
          const sources = result.matches.length ? new Map((await account.readNetwork()).assertions.map(row => [row.id, row])) : new Map()
          const reader = pageReader()
          const picked = await contactRows(result.matches.map(match => sources.get(match.assertionId) ?? { fields: match.fields }), reader)
          const searchResults = await withConnect(session.owner, picked.map((value, index) => ({ ...value, reason: result.matches[index].reason })), reader)
          const view = renderPeople({ ...props, scope: 'own', query: input.get('query'), searchResults, returnTo: searchReturn(input.get('query')) })
          extend(view, `<p class="dir small">${result.considered} ${result.considered === 1 ? 'connection' : 'connections'} searched across your own files.</p>`)
          journey(response, view, props.importJob); return
        }
        // Regenerate: mint the replacement first — a failure leaves the
        // existing setup intact — then revoke every other live grant so old
        // bearer credentials die as soon as the new one exists.
        // OAuth-connected apps are separate connections and stay connected.
        // `access=connections` is the explicit opt-in to connection-request
        // write tools; absent access or `access=read` issues the read-only setup.
        // Unknown fields and unsupported access values are rejected.
        const access = input.getAll('access')
        if (access.length > 1 || (access.length && !['read', 'connections'].includes(access[0])) || (access[0] === 'connections' && !connectionActionsAvailable) || [...input.keys()].some(key => !['csrf', 'access'].includes(key))) throw new Error('private_browser_csrf')
        const issued = await issueAccountGrant(session.owner, undefined, access[0] === 'connections' ? { scope: ACCOUNT_WRITE_SCOPE } : {})
        const { accessToken, grantId: replacement } = issued
        for (const grant of await grantList(session.owner, backend)) if (grant.id !== replacement && !grant.connection) await revokeAccountGrant(session.owner, grant.id)
        const configuration = scopedSetupConfiguration({ endpoint: mcpEndpoint, accessToken })
        const setups = agentClientSetups({ endpoint: mcpEndpoint, accessToken })
        const jobs = await jobResources(), props = jobProps(jobs)
        journey(response, renderSettings({ ...props, imports: summaries(jobs), grants: settingsGrants(await grantList(session.owner, backend)), agentConfiguration: configuration, agentSetups: setups, agentSetupAutomatic: typeof ensureAccountGrant === 'function', connector,
          agentAccess: { scope: issued.scope ?? (access[0] === 'connections' ? ACCOUNT_WRITE_SCOPE : undefined), missingTools: [], regenerated: true }, connectionActionsAvailable }), props.importJob, agentSetupCopyScript()); return
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
        const receipt = await (backgroundImports ? stageArchive : ingestArchive)({ ownerId: session.owner.ownerId, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), adapter: backend.adapter, consent: dataMode === 'private_live' && readPublishedSnapshot ? PUBLIC_UPLOAD_CONSENT : COMBINED_UPLOAD_CONSENT })
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
        if (url.pathname === '/logout') {
          const sid = cookies(request)['__Host-ul-session']
          sessions.delete(sid)
          if (sessionStore && sid) {
            // Awaited: a restart right after sign-out must not restore it.
            await sessionStore.delete(createHash('sha256').update(sid).digest('hex')).catch(() => {})
          }
          response.setHeader('Set-Cookie', cookie('__Host-ul-session', '', 0))
          redirect(response, '/')
          return
        }
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
