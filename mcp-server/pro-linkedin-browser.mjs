import { renderPageShell } from './private-onboarding-views.mjs'

// Browser surface of the owner-only Pro LinkedIn source (docs/pro-linkedin.md):
// the /pro page, its POST actions and the provider's notify endpoint.
// Rules live in mcp-server/pro-linkedin.mjs; this file only renders and routes.

const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const csrfInput = csrf => `<input type="hidden" name="csrf" value="${h(csrf)}">`
const when = at => Number.isFinite(at) ? `<time datetime="${new Date(at).toISOString()}">${h(new Date(at).toISOString().replace('T', ' ').slice(0, 16))} UTC</time>` : 'not yet'
const action = (path, csrf, label, { quiet = false, extra = '' } = {}) => `<form method="post" action="${h(path)}" class="pro-action">${csrfInput(csrf)}${extra}<button type="submit"${quiet ? ' class="quiet sm"' : ''}>${h(label)}</button></form>`

export const PRO_STYLE = '<style>.pro-page .pro-identity{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0 0 8px}.pro-page .pro-identity b{font-size:1.1rem;overflow-wrap:anywhere}.pro-page .pro-state{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line2);font-size:.85rem;white-space:nowrap}.pro-page .pro-state.ok{border-color:#2f8f5b;color:#1f7a4a}.pro-page .pro-state.warn{border-color:#b7791f;color:#8a5a12}.pro-page dl{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:12px 0}.pro-page dt{color:var(--muted)}.pro-page dd{margin:0;overflow-wrap:anywhere}.pro-page .pro-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:16px}.pro-page .pro-action{margin:0}.pro-page .pro-action button{min-height:44px}.pro-page .pro-consent{display:flex;gap:10px;align-items:flex-start;margin:12px 0;min-height:44px}.pro-page .pro-consent input{margin-top:4px;min-width:20px;min-height:20px}.pro-page ul{padding-left:20px}.pro-page .pro-result{padding:14px 0;border-top:1px solid var(--line2)}.pro-page .pro-result:first-of-type{border-top:0}.pro-page .pro-result h3{margin:0 0 2px;font-size:1rem;overflow-wrap:anywhere}.pro-page .pro-tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;border:1px solid var(--line2);font-size:.8rem;font-weight:400;white-space:nowrap}.linkedin-expand{margin-top:12px}.linkedin-expand button{min-height:44px}@media (prefers-color-scheme:dark){.pro-page .pro-state.ok{border-color:#5fc592;color:#7fdcab}.pro-page .pro-state.warn{border-color:#e0b05c;color:#ecc27a}}@media (max-width:520px){.pro-page dl{grid-template-columns:1fr}.pro-page .pro-action,.pro-page .pro-action button{width:100%}}</style>'

const FAILURES = Object.freeze({
  not_configured: 'LinkedIn connection is not set up on this server yet. Nothing was sent to LinkedIn.',
  already_connected: 'A LinkedIn account is already connected. Disconnect it first to connect a different one.',
  not_connected: 'No LinkedIn account is connected.',
  revocation_pending: 'The previous LinkedIn session has not been removed from the provider yet. Try again shortly.',
  rate_limited: 'The provider is limiting requests right now. Wait a little, then try again.',
  daily_limit: 'You have used today’s LinkedIn searches. They reset at midnight UTC.',
  reconnect_required: 'LinkedIn needs you to sign in again. Reconnect, then retry.',
  paused: 'This LinkedIn connection is paused at the provider.',
  not_entitled: 'The provider plan for this account does not include this action.',
  timeout: 'The provider did not answer in time. Nothing was saved; you can try again.',
  provider_unavailable: 'The provider could not be reached. Nothing was saved; you can try again.',
  search_not_enabled: 'LinkedIn search is not switched on yet.',
  superseded: 'The connection changed while this was running. Check the status below.',
  invalid_query: 'Enter a name or a few words to search for.',
  protected_account: 'That account cannot be used here.',
})
const ATTEMPT_FAILURES = Object.freeze({
  account_not_ready: 'LinkedIn did not finish signing in.', account_not_new: 'That provider account already existed, so it was not linked.', account_in_use: 'That LinkedIn account is already linked to another Unlinked account.',
  identity_mismatch: 'A different LinkedIn account signed in. Reconnect only refreshes the account already connected.', account_mismatch: 'The provider answered for a different account.', protected_account: 'That account cannot be used here.',
  verification_failed: 'The provider could not confirm the account.', superseded: 'The connection changed before this finished.', not_eligible: 'Pro access was not available when this finished.',
})
const STATE_LABEL = Object.freeze({ connected: ['Connected', 'ok'], reconnect_required: ['Needs reconnect', 'warn'], paused: ['Paused', 'warn'], disconnected: ['Disconnected', 'warn'] })

export function renderPro({ chrome, status, notice, error }) {
  const { source, attempt, configured, searchEnabled } = status, csrf = chrome.csrf
  const message = error ? `<p class="notice" role="alert">${h(FAILURES[error] ?? 'That did not work. Nothing was changed.')}</p>` : notice ? `<p class="notice" role="status">${h(notice)}</p>` : ''
  const pending = attempt?.state === 'pending' ? `<p class="notice" role="status">Waiting for LinkedIn sign-in to be confirmed. This page shows <b>Connected</b> only after the provider confirms the account to our server; coming back from the sign-in page is not enough. <a href="/pro">Refresh</a></p>`
    : attempt && ['failed', 'expired'].includes(attempt.state) && !source ? `<p class="notice" role="status">The last connection attempt did not complete${attempt.failure && ATTEMPT_FAILURES[attempt.failure] ? `: ${h(ATTEMPT_FAILURES[attempt.failure])}` : attempt.state === 'expired' ? ': the sign-in link expired.' : '.'} Nothing was linked.</p>` : ''
  const promises = `<ul><li>This links <b>your own</b> LinkedIn session as a private source for your account. You still sign in to Unlinked with Ideaflow.</li><li>Nothing from it is published, and it gives no one (including agents) permission to message, invite or post as you.</li><li>You sign in on the provider’s page (Unipile). Unlinked never sees or asks for your LinkedIn password.</li><li>Network sync is <b>not available yet</b>. Connecting does not import your connections.</li></ul>`
  let card
  if (!configured) card = `<div class="card"><h2>LinkedIn</h2><p class="notice" role="status">${h(FAILURES.not_configured)}</p>${promises}</div>`
  else if (source && source.state !== 'disconnected') {
    const [label, tone] = STATE_LABEL[source.state] ?? STATE_LABEL.reconnect_required
    card = `<div class="card"><h2>LinkedIn</h2><p class="pro-identity"><b>${h(source.name || 'LinkedIn account')}</b><span class="pro-state ${tone}">${label}</span></p><dl><dt>LinkedIn profile</dt><dd>${source.profileUrl ? `<a href="${h(source.profileUrl)}" target="_blank" rel="noopener noreferrer">${h(source.profileUrl.replace('https://www.', ''))} ↗</a>` : 'Address not provided'}</dd><dt>Connected</dt><dd>${when(source.connectedAt)}</dd><dt>Last confirmed</dt><dd>${when(source.verifiedAt)}${source.stale ? ' · <span class="small">not checked in the last day</span>' : ''}</dd><dt>Network sync</dt><dd>Not available yet</dd><dt>LinkedIn search</dt><dd>${searchEnabled ? 'On · offered after an Unlinked search finds no one' : 'Not switched on yet'}</dd></dl><div class="pro-actions">${action('/pro/linkedin/check', csrf, 'Check connection', { quiet: true })}${source.state === 'reconnect_required' ? action('/pro/linkedin/reconnect', csrf, 'Reconnect LinkedIn') : ''}${action('/pro/linkedin/disconnect', csrf, 'Disconnect', { quiet: true })}</div><p class="small">Wrong account? Disconnect, then connect the right one. Disconnect removes this LinkedIn session from the provider; your imports, notes and lists are not touched.</p></div>`
  } else card = `<div class="card"><h2>Connect LinkedIn via Unipile</h2>${source?.providerRevocation === 'pending' ? '<p class="notice" role="status">Your previous LinkedIn session is disconnected here but has not been removed from the provider yet. It will be retried when you connect again.</p>' : ''}${promises}<form method="post" action="/pro/linkedin/connect">${csrfInput(csrf)}<label class="pro-consent"><input type="checkbox" name="consent" value="on" required><span>I understand and want to link my own LinkedIn account as a private source.</span></label><button type="submit">Connect LinkedIn</button></form><p class="small">The sign-in link is single-use and expires after 15 minutes.</p></div>`
  return { ...renderPageShell('Pro', `${PRO_STYLE}<section class="narrow wide pro-page"><h1 class="hq">Pro</h1><p class="lead">Early access for this account. More of your own network, kept private.</p>${message}${pending}${card}</section>`, chrome) }
}

// The page's form policy stays same-origin: the provider page is opened by a
// plain link, never by a form redirect.
export function renderProContinue({ chrome, link, reconnect = false }) {
  return { ...renderPageShell('Continue to LinkedIn sign-in', `${PRO_STYLE}<section class="narrow wide pro-page"><p class="small"><a href="/pro">← Back to Pro</a></p><h1 class="hq">${reconnect ? 'Reconnect LinkedIn' : 'Connect LinkedIn'}</h1><div class="card"><p>You will sign in to LinkedIn on the provider’s page (Unipile), then come back here. Unlinked never sees your LinkedIn password.</p><p><a class="button" href="${h(link.url)}" rel="noreferrer">Continue to LinkedIn sign-in</a></p><p class="small">This single-use link expires at ${when(link.expiresAt)}. After you return, Pro shows Connected only once the provider has confirmed the account to our server.</p></div></section>`, chrome) }
}

export function renderProSearch({ chrome, query, result, error, retryAfter }) {
  const back = `<p class="small"><a href="${h('/network?q=' + encodeURIComponent(query))}">← Back to Unlinked results</a></p>`
  let body
  if (error) body = `<p class="notice" role="alert"><b>LinkedIn search did not run.</b> ${h(FAILURES[error] ?? FAILURES.provider_unavailable)}${retryAfter ? ` Try again in about ${Math.max(1, Math.ceil(retryAfter / 60))} min.` : ''}</p>${error === 'reconnect_required' ? '<p><a class="button sec sm" href="/pro">Open Pro to reconnect</a></p>' : ''}<p class="small">This is a problem reaching LinkedIn, not a “no results” answer.</p>`
  else {
    const rows = result.people.map(person => `<div class="pro-result"><h3>${h(person.name)}<span class="pro-tag">${person.existing ? 'Already on Unlinked' : 'LinkedIn · not yet on Unlinked'}</span></h3>${person.headline ? `<p>${h(person.headline)}</p>` : ''}<p class="small">${[person.location, person.networkDistance ? `LinkedIn ${['1st', '2nd', '3rd'][person.networkDistance - 1]}-degree` : null].filter(Boolean).map(h).join(' · ')}</p><p class="small">${person.existing ? `<a href="${h(person.existing)}">Open on Unlinked</a> · ` : ''}<a href="${h(person.linkedinUrl)}" target="_blank" rel="noopener noreferrer">Open on LinkedIn ↗</a></p></div>`).join('')
    body = `${result.people.length ? `<div class="card">${rows}</div>` : `<p class="notice" role="status">LinkedIn search ran and found no people for “${h(query)}”.</p>`}<p class="small">From LinkedIn through ${h(result.account.name || 'your')} connected account · ${when(result.observedAt)} · ${result.people.length} shown${result.total !== undefined ? ` of about ${result.total}` : ''}${result.skipped ? ` · ${result.skipped} without a public address left out` : ''} · ${result.remainingToday} searches left today.</p><p class="small">This is a private preview. It is not saved, published or added to your network, and no one was messaged or invited. Saving a person is a separate step that is not available yet.</p>`
  }
  return { ...renderPageShell(`“${query}” · LinkedIn search`, `${PRO_STYLE}<section class="narrow wide pro-page">${back}<h1 class="hq">LinkedIn search</h1><p class="lead">“${h(query)}”</p>${body}</section>`, chrome) }
}

// The explicit offer under a finished Unlinked search that found no one.
export const linkedinExpandOffer = ({ csrf, query }) => `${PRO_STYLE}<form class="linkedin-expand" method="post" action="/pro/linkedin/search">${csrfInput(csrf)}<input type="hidden" name="q" value="${h(query)}"><button type="submit" class="sec">Search LinkedIn for “${h(query)}”</button><p class="small">Uses your connected LinkedIn account once, only when you press this. Results are a private preview.</p></form>`

export function createProLinkedinBrowser({ pro, body, resolveExisting }) {
  const form = async (request, session, allowed) => {
    const input = new URLSearchParams((await body(request, 4096)).toString('utf8'))
    if (input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || [...input.keys()].some(key => !allowed.includes(key)) || allowed.some(key => input.getAll(key).length > 1)) throw new Error('private_browser_csrf')
    return input
  }
  const handler = async ({ request, url, session, render, redirect, notFound }) => {
    const owner = session?.owner
    // Not advertised: anyone who is not an eligible signed-in owner sees the ordinary 404.
    if (!owner || !pro.eligible(owner)) return notFound()
    const chrome = { accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf, headline: session.headline }
    const page = async (extra = {}, status = 200) => render(renderPro({ chrome, status: await pro.status(owner), ...extra }), status)
    if (request.method === 'GET' && url.pathname === '/pro') {
      const returned = url.searchParams.get('linkedin')
      return page(returned === 'cancelled' ? { notice: 'LinkedIn sign-in was not completed. Nothing was linked.' } : url.searchParams.get('done') === 'disconnected' ? { notice: 'LinkedIn disconnected.' } : url.searchParams.get('done') === 'disconnect-pending' ? { notice: 'LinkedIn is disconnected here. Removing the session from the provider did not finish and will be retried.' } : url.searchParams.get('done') === 'checked' ? { notice: 'Connection checked.' } : {})
    }
    if (request.method !== 'POST') return notFound()
    try {
      if (url.pathname === '/pro/linkedin/connect') {
        const input = await form(request, session, ['csrf', 'consent'])
        if (input.get('consent') !== 'on') return page({ error: 'invalid_consent' }, 400)
        return render(renderProContinue({ chrome, link: await pro.begin(owner) }))
      }
      if (url.pathname === '/pro/linkedin/reconnect') { await form(request, session, ['csrf']); return render(renderProContinue({ chrome, link: await pro.begin(owner, { reconnect: true }), reconnect: true })) }
      if (url.pathname === '/pro/linkedin/check') { await form(request, session, ['csrf']); await pro.check(owner); return redirect('/pro?done=checked') }
      if (url.pathname === '/pro/linkedin/disconnect') { await form(request, session, ['csrf']); const result = await pro.disconnect(owner); return redirect(result.pending ? '/pro?done=disconnect-pending' : '/pro?done=disconnected') }
      if (url.pathname === '/pro/linkedin/search') {
        const input = await form(request, session, ['csrf', 'q']), query = (input.get('q') ?? '').trim()
        try {
          const result = await pro.search(owner, query)
          // Exact LinkedIn address only; a name never marks someone as existing.
          const existing = typeof resolveExisting === 'function' ? await resolveExisting(request, result.people.map(person => person.linkedinUrl)).catch(() => new Map()) : new Map()
          return render(renderProSearch({ chrome, query, result: { ...result, people: result.people.map(person => existing.get(person.linkedinUrl) ? { ...person, existing: existing.get(person.linkedinUrl) } : person) } }))
        } catch (error) {
          if (!error?.code || error.message === 'private_browser_csrf') throw error
          return render(renderProSearch({ chrome, query, error: error.code, retryAfter: error.retryAfter }), ['invalid_query'].includes(error.code) ? 400 : ['rate_limited', 'daily_limit'].includes(error.code) ? 429 : ['provider_unavailable', 'timeout'].includes(error.code) ? 503 : 409)
        }
      }
    } catch (error) {
      if (!error?.code || !String(error.message).startsWith('pro_linkedin_')) throw error
      return page({ error: error.code }, ['rate_limited'].includes(error.code) ? 429 : ['provider_unavailable', 'timeout', 'not_configured'].includes(error.code) ? 503 : 409)
    }
    return notFound()
  }
  // The offer for the People page; empty unless this owner can actually use it now.
  handler.offer = async (session, query) => {
    try {
      if (!session?.owner || !pro.eligible(session.owner) || typeof query !== 'string' || !query.trim()) return ''
      const status = await pro.status(session.owner)
      return status.configured && status.searchEnabled && status.source?.state === 'connected' ? linkedinExpandOffer({ csrf: session.csrf, query: query.trim() }) : ''
    } catch { return '' }
  }
  return handler
}

export const PRO_NOTIFY_PREFIX = '/api/pro/linkedin/notify/'
// Server-to-server callback from the provider. No session, no cookies, no
// CORS; the response never says why something was not accepted.
export function createProLinkedinNotifyHandler({ pro, body }) {
  return async (request, response) => {
    const send = status => { response.writeHead(status, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Length': '0' }); response.end() }
    try {
      const url = new URL(request.url, 'https://unlinked.invalid')
      if (!url.pathname.startsWith(PRO_NOTIFY_PREFIX) || url.search) return send(404)
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405) }
      if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return send(415)
      let payload
      try { payload = JSON.parse((await body(request, 4096)).toString('utf8')) } catch { return send(400) }
      return send(await pro.notify(url.pathname.slice(PRO_NOTIFY_PREFIX.length), payload) === 'accepted' ? 204 : 404)
    } catch { if (!response.headersSent) send(503) }
  }
}
