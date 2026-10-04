import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { NOTIFICATION_KINDS } from './member-notifications.mjs'
import { HEAVY_INVITES_PER_DAY } from './member-invitations.mjs'

// Email delivery configuration and contracts are owned by docs/email.md. Nothing
// here ever logs or returns an email address, a token or the API key.

export const RESEND_ENDPOINT = 'https://api.resend.com/emails'
export const DEFAULT_EMAIL_FROM = 'Unlinked <noreply@id.ideaflow.app>'
// Matches the heavy-use report for invite links (member-invitations.mjs).
export const INVITE_EMAILS_PER_DAY = HEAVY_INVITES_PER_DAY
export const INVITE_RECIPIENT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000
// At most one notification email per member per window; several become one digest.
export const NOTIFICATION_EMAIL_WINDOW_MS = 15 * 60 * 1000
// Notification defaults come from NOTIFICATION_KINDS[kind].email;
// export reminders are a separate preference, enabled by default.
export const EMAIL_PREFERENCES = Object.freeze({
  connection_request_received: 'Someone asks to connect with you',
  connection_request_accepted: 'Someone accepts your connection request',
  invite_accepted: 'Someone accepts your invite and joins',
  profile_claimed: 'Someone you listed as a connection joins and claims their profile',
  linkedin_import_reminder: 'Remind me to download and upload my LinkedIn export',
})
const DAY = 24 * 60 * 60 * 1000
const OFF = ['false', '0', 'off', 'no']

// `status` is the provider's HTTP status (null for network errors);
// `retryAfterMs` is its Retry-After, when it sent one.
export class EmailError extends Error {
  constructor(code, { status = null, retryAfterMs = null } = {}) { super(code); this.code = code; this.status = status; this.retryAfterMs = retryAfterMs }
}
// Provider throttling or outage, or a rejected key: every send would fail, so the mailer pauses.
const globalFailure = error => error instanceof EmailError && (error.status === 429 || error.status === 401 || (error.status ?? 0) >= 500)
// Any other 4xx rejects this message for good (bad recipient, unverified sender...).
const permanentFailure = error => error instanceof EmailError && ((error.status >= 400 && error.status < 500 && !globalFailure(error)) || ['email_recipient_invalid', 'email_header_invalid'].includes(error.code))
export const BACKOFF_START_MS = 2 * 60 * 1000
export const BACKOFF_MAX_MS = 60 * 60 * 1000
export const backoffMs = attempts => Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, Math.min(attempts, 20)))
function retryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 24 * 60 * 60 * 1000)) : null
}

// --- Addresses and header safety -------------------------------------------

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
// A single plain address, or null. Anything with spaces, CR/LF, quotes or
// several addresses is refused rather than repaired.
export function emailAddress(value) {
  if (typeof value !== 'string') return null
  const address = value.trim()
  return address.length <= 254 && ADDRESS.test(address) && !address.includes('..') ? address : null
}
const normalized = address => address.toLowerCase()

// One header line: control characters (CR, LF, NUL, U+2028/9) become spaces.
export function headerText(value, max = 200) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, max).join('')
}
// A display name safe inside a quoted From header. A "name" that contains an
// address (a sign-in without a display name) is not used at all.
export function senderName(value) {
  const text = headerText(value, 80)
  const name = text.includes('@') ? '' : text.replace(/["\\<>,;:]/g, '').replace(/\s+/g, ' ').trim()
  return name || 'An Unlinked member'
}
function parseFrom(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const named = text.match(/^([^<>"\r\n]{0,80})<([^<>\s]+)>$/)
  const address = emailAddress(named ? named[2] : text)
  if (!address || /[\r\n]/.test(text)) return null
  return { name: named ? senderName(named[1]) : 'Unlinked', address }
}
const fromHeader = (name, address) => `"${senderName(name)}" <${address}>`
// "<Member> via Unlinked": a long name is shortened, never the suffix.
export function inviteFromHeader(name, address) {
  const short = [...senderName(name)].slice(0, 60).join('').trim()
  return `"${short} via Unlinked" <${address}>`
}
// UNLINKED_EMAIL_SECRET: hex, or base64/base64url; at least 32 bytes once decoded.
export function emailSecret(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const bytes = /^(?:[0-9a-fA-F]{2})+$/.test(text) ? Buffer.from(text, 'hex') : /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : null
  return bytes && bytes.length >= 32 ? new Uint8Array(bytes) : null
}
export const DEFAULT_SITE_INVITE_EMAILS_PER_DAY = 500
export const NEW_ACCOUNT_INVITE_EMAILS_PER_DAY = 10

// --- Configuration and transport -------------------------------------------

// The flag defaults on; without a key, or without a usable UNLINKED_EMAIL_SECRET,
// nothing is sent and the app behaves as before. `problem` is a non-secret reason.
export function emailConfig(env = process.env) {
  const flag = String(env.UNLINKED_EMAIL_ENABLED ?? '').trim().toLowerCase()
  const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : ''
  const from = parseFrom(env.UNLINKED_EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM)
  const secret = emailSecret(env.UNLINKED_EMAIL_SECRET)
  const site = String(env.UNLINKED_INVITE_EMAILS_PER_DAY ?? '').trim()
  const invitesPerDay = /^\d{1,7}$/.test(site) ? Number(site) : DEFAULT_SITE_INVITE_EMAILS_PER_DAY
  const switchedOff = OFF.includes(flag)
  const problem = switchedOff ? null : !apiKey ? null : !secret ? 'email_secret_missing_or_short' : !from ? 'email_from_invalid' : null
  const config = { enabled: !switchedOff && Boolean(apiKey) && Boolean(from) && Boolean(secret), switchedOff, from, invitesPerDay, problem }
  // The key and secret never appear in JSON, logs or inspection of the config.
  Object.defineProperty(config, 'apiKey', { value: apiKey || null, enumerable: false })
  Object.defineProperty(config, 'secret', { value: secret, enumerable: false })
  return config
}

// Resend's HTTP API through fetch; no SDK. Errors carry only an HTTP status.
export function createResendTransport({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('email_transport_key_required')
  return {
    async send(message) {
      const payload = { from: message.from, to: [message.to], subject: message.subject, text: message.text, html: message.html,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}), ...(message.headers ? { headers: message.headers } : {}) }
      let response
      try {
        response = await fetchImpl(RESEND_ENDPOINT, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}) } })
      } catch { throw new EmailError('email_transport_unreachable') }
      if (!response.ok) {
        const wait = retryAfter(response.headers?.get?.('retry-after'))
        await response.body?.cancel?.().catch?.(() => {})
        throw new EmailError(`email_transport_status_${response.status}`, { status: response.status, retryAfterMs: wait })
      }
      const value = await response.json().catch(() => ({}))
      return { id: typeof value?.id === 'string' ? value.id : null }
    },
  }
}

// Every outgoing message passes here: one recipient, header-safe fields only.
function message({ from, to, replyTo, subject, text, html, unsubscribeUrl, idempotencyKey }) {
  const address = emailAddress(to)
  if (!address) throw new EmailError('email_recipient_invalid')
  const reply = replyTo ? emailAddress(replyTo) : null
  if (/[\r\n]/.test(from) || /[\r\n]/.test(unsubscribeUrl)) throw new EmailError('email_header_invalid')
  return { from, to: address, ...(reply ? { replyTo: reply } : {}), subject: headerText(subject, 160), text, html, idempotencyKey,
    // RFC 8058 one-click unsubscribe (and RFC 2369 for older clients).
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }
}

// --- Unsubscribe tokens ----------------------------------------------------

// `v1.<payload>.<mac>`: HMAC-SHA256 over a JSON payload naming who (an account
// key or an address hash, never an address) and what to stop. Works signed out.
export function createUnsubscribeTokens({ key, now = Date.now, ttlMs = UNSUBSCRIBE_TTL_MS }) {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new Error('email_unsubscribe_key_required')
  const mac = body => createHmac('sha256', key).update(`unlinked-email-unsubscribe-v1\u0000${body}`).digest()
  return {
    issue({ scope, subject, kinds }) {
      const body = Buffer.from(JSON.stringify({ s: scope, h: subject, k: kinds, x: now() + ttlMs })).toString('base64url')
      return `v1.${body}.${mac(body).toString('base64url')}`
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 700) return null
      const parts = token.match(/^v1\.([A-Za-z0-9_-]{16,600})\.([A-Za-z0-9_-]{43})$/)
      if (!parts) return null
      const given = Buffer.from(parts[2], 'base64url'), expected = mac(parts[1])
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      let value
      try { value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
      const kinds = Array.isArray(value?.k) ? value.k : []
      const scopeKinds = value?.s === 'member' ? Object.keys(EMAIL_PREFERENCES) : value?.s === 'address' ? ['invite'] : []
      if (!/^[a-f0-9]{64}$/.test(value?.h ?? '') || !Number.isSafeInteger(value?.x) || value.x <= now() || !kinds.length || kinds.some(kind => !scopeKinds.includes(kind))) return null
      return { scope: value.s, subject: value.h, kinds, expiresAt: value.x }
    },
  }
}

// --- Templates -------------------------------------------------------------

const html = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
function layout({ lines, action, why, unsubscribeUrl, unsubscribeLabel }) {
  const text = [...lines, '', `${action.label}: ${action.url}`, '', '--', why, `${unsubscribeLabel}: ${unsubscribeUrl}`, '', 'Unlinked · https://www.unlinked.ai'].join('\n')
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><body style="margin:0;padding:24px;background:#f5f6fc;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#16181d"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e8ec;border-radius:8px;padding:24px"><p style="margin:0 0 16px;font-weight:700;font-size:20px;letter-spacing:-.04em;color:#4349c4">unlinked</p>${lines.filter(Boolean).map(line => `<p style="margin:0 0 12px">${html(line)}</p>`).join('')}<p style="margin:20px 0"><a href="${html(action.url)}" style="display:inline-block;padding:10px 18px;background:#4349c4;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${html(action.label)}</a></p><p style="margin:24px 0 0;font-size:13px;color:#667085">${html(why)} <a href="${html(unsubscribeUrl)}" style="color:#667085">${html(unsubscribeLabel)}</a>.</p></div></body></html>`
  return { text, html: body }
}

export function inviteEmail({ inviterName, inviteeName, link, unsubscribeUrl, canReply }) {
  const inviter = senderName(inviterName), invitee = headerText(inviteeName, 120)
  return {
    subject: `${inviter} invited you to Unlinked`,
    ...layout({
      lines: [invitee ? `Hi ${invitee},` : 'Hi,', `${inviter} invited you to join them on Unlinked, where people find each other through the people they already know.`,
        `The link works once. Accepting asks you to sign in, and connects you with ${inviter}.`, canReply ? `Reply to this email to answer ${inviter} directly.` : ''],
      action: { label: 'Accept the invite', url: link },
      why: `You got this email because ${inviter} entered your address when inviting you to Unlinked. Unlinked does not keep your address.`,
      unsubscribeUrl, unsubscribeLabel: 'Never get invite emails from Unlinked',
    }),
  }
}

const SENTENCES = {
  connection_request_received: name => [`${name} wants to connect on Unlinked`, `${name} asked to connect with you on Unlinked.`],
  connection_request_accepted: name => [`${name} accepted your connection request`, `${name} accepted your connection request. You are now connected on Unlinked.`],
  invite_accepted: name => [`${name} accepted your invite`, `${name} accepted your invite and joined Unlinked. You are now connected.`],
  profile_claimed: name => [`${name} joined Unlinked`, `${name}, who is in your LinkedIn connections, joined Unlinked and claimed their profile.`],
}
export function notificationEmail({ items, origin, unsubscribeUrl }) {
  const name = item => headerText(item.actorName, 120) || 'An Unlinked member'
  const single = items.length === 1
  const [subject, sentence] = single ? SENTENCES[items[0].kind](name(items[0])) : [`${items.length} new notifications on Unlinked`, null]
  return {
    subject,
    ...layout({
      lines: single ? [sentence] : ['Here is what happened on Unlinked:', ...items.map(item => `• ${SENTENCES[item.kind](name(item))[1]}`)],
      action: single ? { label: items[0].kind === 'connection_request_received' ? 'See the request' : 'Open Unlinked', url: `${origin}/notifications/${items[0].id}` } : { label: 'See your notifications', url: `${origin}/notifications` },
      why: `You got this email because you have an Unlinked account and these emails are on. Choose which emails you get in Settings: ${origin}/settings#email.`,
      unsubscribeUrl, unsubscribeLabel: single ? 'Stop emails like this' : 'Stop these emails',
    }),
  }
}

export function linkedinImportReminderEmail({ stage, origin, unsubscribeUrl }) {
  return {
    subject: stage === 2 ? 'Remember to save your LinkedIn export before the link expires' : 'Your LinkedIn export may be ready — bring it to Unlinked',
    ...layout({
      lines: ['You signed up for Unlinked but have not uploaded your LinkedIn export yet.',
        'If you requested your archive, check your inbox for LinkedIn’s email. Its download link is available for only 3 days (72 hours) after the archive is ready.',
        'Download the file while the link works, then upload it to Unlinked. Your saved file does not expire.',
        'If you have not requested it yet, choose “Download larger data archive” (recommended) in LinkedIn’s data download settings. It is usually ready in about a day; some data can take up to 48 hours.',
        'If the link has expired, request a new export from LinkedIn.'],
      action: { label: 'Upload my LinkedIn export', url: `${origin}/import` },
      why: 'You got this email because you signed up for Unlinked and LinkedIn export reminders are on.',
      unsubscribeUrl, unsubscribeLabel: 'Stop LinkedIn export reminders',
    }),
  }
}

// --- The service -----------------------------------------------------------

export const accountKey = member => createHash('sha256').update(`unlinked-email-account-v1\u0000${member.ownerId}\u0000${member.userId}`).digest('hex')
const owner = value => {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.userId !== 'string' || !value.userId) throw new Error('email_owner_required')
  return value
}
const defaults = () => Object.fromEntries(Object.keys(EMAIL_PREFERENCES).map(kind => [kind, kind === 'linkedin_import_reminder' || NOTIFICATION_KINDS[kind]?.email === true]))
const preferencesOf = record => {
  const value = { ...defaults() }
  let saved = {}
  try { saved = typeof record?.preferences === 'string' ? JSON.parse(record.preferences) : record?.preferences ?? {} } catch { saved = {} }
  for (const kind of Object.keys(value)) if (typeof saved?.[kind] === 'boolean') value[kind] = saved[kind]
  return value
}


// `secret` keys the unsubscribe MAC and the address hashes. `transport` is
// Resend in production and a fake in tests. Without `config.enabled` nothing
// is ever sent and no address is recorded.
export function createMemberEmail({ config, transport, store, notificationStore, secret, origin, now = Date.now, onError = () => {},
  hasLinkedInUpload, windowMs = NOTIFICATION_EMAIL_WINDOW_MS, minAgeMs = 60 * 1000, maxAgeMs = DAY, claimMs = 10 * 60 * 1000, recipientsPerRun = 100,
  siteInvitesPerDay = config?.invitesPerDay ?? DEFAULT_SITE_INVITE_EMAILS_PER_DAY }) {
  if (!store || ['initialize', 'getRecipient', 'setAddress', 'noteNewAccount', 'setPreferences', 'unsubscribe', 'markNotified', 'setRetry', 'heldRecipients', 'deleteOwner', 'isSuppressed', 'suppress', 'reserveInvite', 'releaseSend', 'pendingImportReminders', 'claimImportReminder', 'settleImportReminder', 'releaseImportReminder', 'finishImportReminders'].some(name => typeof store[name] !== 'function')) throw new Error('email_store_required')
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new Error('email_secret_required')
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) throw new Error('email_origin_required')
  const sending = config?.enabled === true && typeof transport?.send === 'function'
  const subkey = label => createHmac('sha256', secret).update(label).digest()
  const tokens = createUnsubscribeTokens({ key: subkey('unlinked-email-unsubscribe-key-v1'), now })
  const addressKey = subkey('unlinked-email-address-key-v1')
  const addressHash = address => createHmac('sha256', addressKey).update(`invitee\u0000${normalized(address)}`).digest('hex')
  const unsubscribeUrl = token => `${base.origin}/email/unsubscribe?t=${token}`
  const report = event => { try { void Promise.resolve(onError(event)).catch(() => {}) } catch { /* reporting never fails delivery */ } }
  const code = error => error instanceof EmailError ? error.code : 'email_error'
  let timer = null, running = null, remindersRunning = null
  // Provider-wide pause (429, 5xx, rejected key), shared by invites and the mailer.
  let pausedUntil = 0, pauseAttempts = 0
  const pause = (error, at) => { pausedUntil = at + (error.retryAfterMs ?? backoffMs(pauseAttempts)); pauseAttempts++ }

  const service = {
    sending,
    get from() { return config?.from ? fromHeader(config.from.name, config.from.address) : null },
    get pausedUntil() { return pausedUntil },
    initialize: () => store.initialize(),
    // At sign-in: the address the member signs in with (only a verified one is
    // ever emailed or used as Reply-To), and when a brand-new account began.
    async rememberAddress(member, { address, verified, newAccount = false }) {
      owner(member)
      if (!sending) return false
      const key = accountKey(member), at = now()
      if (newAccount) await store.noteNewAccount(member, key, at)
      const value = emailAddress(address)
      if (!value) return false
      await store.setAddress(member, key, { address: value, verified: verified === true, at })
      return true
    },
    async settings(member) {
      const record = await store.getRecipient(accountKey(owner(member)))
      return { sending, address: record?.verified ? record.address : null, preferences: preferencesOf(record) }
    },
    async savePreferences(member, chosen) {
      owner(member)
      const list = Array.isArray(chosen) ? chosen : []
      if (list.some(kind => !Object.hasOwn(EMAIL_PREFERENCES, kind))) throw new EmailError('email_preference_invalid')
      const value = Object.fromEntries(Object.keys(EMAIL_PREFERENCES).map(kind => [kind, list.includes(kind)]))
      await store.setPreferences(member, accountKey(member), JSON.stringify(value), now())
      return value
    },
    // Sends the invite link the member just created. The raw link exists only
    // here; the invitee's address is used once and never stored (only a keyed
    // hash, for the per-recipient limit, for seven days). The member, recipient
    // and site-wide limits are checked and reserved in one atomic store step.
    async sendInvite({ inviter, inviterName, inviteeName, address, token, invitationId }) {
      owner(inviter)
      if (!sending) return { sent: false, reason: 'off' }
      const to = emailAddress(address)
      if (!to || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { sent: false, reason: 'invalid' }
      if (pausedUntil > now()) return { sent: false, reason: 'failed' }
      const recipientHash = addressHash(to), senderKey = accountKey(inviter)
      if (await store.isSuppressed(recipientHash)) return { sent: false, reason: 'unavailable' }
      const sender = await store.getRecipient(senderKey).catch(() => null)
      const at = now(), id = randomUUID()
      const fresh = sender?.accountCreatedAt != null && at - sender.accountCreatedAt < DAY
      const outcome = await store.reserveInvite({ id, senderKey, recipientHash, at, since: at - DAY, recipientSince: at - INVITE_RECIPIENT_COOLDOWN_MS, pruneBefore: at - INVITE_RECIPIENT_COOLDOWN_MS,
        senderLimit: fresh ? NEW_ACCOUNT_INVITE_EMAILS_PER_DAY : INVITE_EMAILS_PER_DAY, siteLimit: siteInvitesPerDay })
      if (outcome !== 'ok') return { sent: false, reason: { recipient: 'unavailable', member: 'member_limit', site: 'site_limit' }[outcome] ?? 'failed' }
      try {
        const replyTo = sender?.verified ? sender.address : null
        const link = unsubscribeUrl(tokens.issue({ scope: 'address', subject: recipientHash, kinds: ['invite'] }))
        const content = inviteEmail({ inviterName, inviteeName, link: `${base.origin}/i/${token}`, canReply: Boolean(replyTo), unsubscribeUrl: link })
        await transport.send(message({ ...content, to, replyTo, from: inviteFromHeader(inviterName, config.from.address),
          unsubscribeUrl: link, idempotencyKey: `unlinked-invite-${invitationId ?? id}` }))
        pauseAttempts = 0
        return { sent: true }
      } catch (error) {
        await store.releaseSend(id).catch(() => {})
        if (globalFailure(error)) pause(error, now())
        report({ event: 'email_invite_failed', code: code(error) })
        return { sent: false, reason: 'failed' }
      }
    },
    // What an unsubscribe link would stop, without changing anything (the GET page).
    inspectUnsubscribe(token) { return tokens.verify(token) },
    async unsubscribe(token) {
      const value = tokens.verify(token)
      if (!value) return null
      if (value.scope === 'address') await store.suppress(value.subject, now())
      else await store.unsubscribe(value.subject, value.kinds, now())
      return value
    },
    // One pass of the notification mailer. Safe to call concurrently (one runs).
    runNotifications() {
      if (!sending || !notificationStore) return Promise.resolve({ sent: 0, skipped: 0, waiting: 0, failed: 0 })
      if (running) return running
      running = deliverNotifications().finally(() => { running = null })
      return running
    },
    // Two bounded reminders per new account; durable stage/claim state lives
    // on its existing private recipient record, deleted with the account.
    runImportReminders() {
      if (!sending || typeof hasLinkedInUpload !== 'function') return Promise.resolve({ sent: 0, skipped: 0, failed: 0 })
      if (remindersRunning) return remindersRunning
      remindersRunning = deliverImportReminders().finally(() => { remindersRunning = null })
      return remindersRunning
    },
    async completeImportReminders(member) { await store.finishImportReminders(accountKey(owner(member))) },
    // In-process timer; never awaited by startup, never throws out of a tick.
    start({ intervalMs = 60 * 1000 } = {}) {
      if (!sending || (!notificationStore && typeof hasLinkedInUpload !== 'function') || timer) return false
      timer = setInterval(() => {
        service.runNotifications().then(() => service.runImportReminders()).catch(error => report({ event: 'email_notifications_failed', code: error?.code ?? 'email_mailer_error' }))
      }, intervalMs)
      timer.unref?.()
      return true
    },
    async stop() { if (timer) clearInterval(timer); timer = null; await running?.catch(() => {}); await remindersRunning?.catch(() => {}) },
    async exportOwner(member) {
      const value = await service.settings(member)
      return { address: value.address, preferences: value.preferences }
    },
    // Account deletion: the stored address, preferences and invite-send counters.
    async removeOwner(member) { await store.deleteOwner(accountKey(owner(member))) },
  }

  async function deliverImportReminders() {
    const at = now(), result = { sent: 0, skipped: 0, failed: 0 }
    if (pausedUntil > at) return { ...result, paused: true }
    const pending = await store.pendingImportReminders({ at, staleClaimBefore: at - claimMs, limit: recipientsPerRun })
    for (const candidate of pending) {
      const key = candidate.accountKey, member = { ownerId: candidate.ownerId, userId: candidate.userId }
      const stage = at - candidate.accountCreatedAt >= 3 * DAY ? 2 : 1
      const claim = randomUUID()
      let recipient
      try {
        const reminderTokens = createUnsubscribeTokens({ key: subkey('unlinked-email-unsubscribe-key-v1'), now: () => candidate.accountCreatedAt })
        const link = unsubscribeUrl(reminderTokens.issue({ scope: 'member', subject: key, kinds: ['linkedin_import_reminder'] }))
        const content = linkedinImportReminderEmail({ stage, origin: base.origin, unsubscribeUrl: link })
        const payload = JSON.stringify(message({ ...content, to: candidate.address, from: service.from, unsubscribeUrl: link,
          idempotencyKey: `unlinked-import-${key}-${stage}` }))
        recipient = await store.claimImportReminder(key, { stage, claim, at, staleClaimBefore: at - claimMs, payload })
        if (!recipient) continue
        // Preferences/address can change after discovery. Recheck upload after
        // the claim too, including an uploaded file still processing.
        const current = await store.getRecipient(key)
        if (!current || !current.verified || !emailAddress(current.address) || !preferencesOf(current).linkedin_import_reminder || current.importReminderStage === 2 || await hasLinkedInUpload(member)) {
          await store.finishImportReminders(key); result.skipped++; continue
        }
        // Keep retries within Resend’s 24-hour idempotency retention. No old
        // reminder backlog after downtime, and no two catch-up emails at once.
        if (at - recipient.importReminderAttemptAt >= 23 * 60 * 60 * 1000) {
          await store.settleImportReminder(key, { stage, claim }); result.skipped++; continue
        }
        await transport.send(JSON.parse(recipient.importReminderPayload))
        pauseAttempts = 0
        await store.settleImportReminder(key, { stage, claim })
        result.sent++
      } catch (error) {
        result.failed++; report({ event: 'email_import_reminder_failed', code: code(error) })
        if (permanentFailure(error)) { await store.settleImportReminder(key, { stage, claim }); continue }
        await store.releaseImportReminder(key, claim).catch(() => {})
        if (globalFailure(error)) { pause(error, at); result.paused = true; break }
        const attempts = recipient?.retryAttempts ?? 0
        await store.setRetry(key, { retryAfter: at + backoffMs(attempts), attempts: attempts + 1 })
      }
    }
    return result
  }

  async function deliverNotifications() {
    const at = now(), result = { sent: 0, skipped: 0, waiting: 0, failed: 0 }
    if (pausedUntil > at) return { ...result, paused: true }
    // Members inside their window or backoff are excluded from the batch, so
    // held or failing rows can never fill it and starve everyone else.
    const exclude = await store.heldRecipients({ notifiedSince: at - windowMs, now: at, limit: 10000 })
    const pending = await notificationStore.pendingEmail({ since: at - maxAgeMs, before: at - minAgeMs, staleClaimBefore: at - claimMs, limit: 500, exclude })
    const groups = new Map()
    for (const record of pending) {
      const key = `${record.recipientOwnerId}\u0000${record.recipientUserId}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(record)
    }
    for (const records of [...groups.values()].slice(0, recipientsPerRun)) {
      const member = { ownerId: records[0].recipientOwnerId, userId: records[0].recipientUserId }
      try {
        const key = accountKey(member), recipient = await store.getRecipient(key), preferences = preferencesOf(recipient)
        const usable = recipient?.verified === true && emailAddress(recipient.address)
        // Already seen in the app, turned off, or no verified address: settled without email.
        const wanted = usable ? records.filter(record => preferences[record.kind] === true && record.seenAt == null) : []
        const settled = records.filter(record => !wanted.includes(record))
        if (settled.length) result.skipped += await notificationStore.markEmailed(settled.map(record => record.id), { claim: null, at, outcome: 'skipped', staleClaimBefore: at - claimMs })
        if (!wanted.length) continue
        if ((recipient.lastNotifiedAt != null && at - recipient.lastNotifiedAt < windowMs) || (recipient.retryAfter ?? 0) > at) { result.waiting += wanted.length; continue }
        const claim = randomUUID()
        const claimed = new Set(await notificationStore.claimEmail(wanted.map(record => record.id), { claim, at, staleClaimBefore: at - claimMs }))
        const items = wanted.filter(record => claimed.has(record.id)).sort((a, b) => a.createdAt - b.createdAt)
        if (!items.length) continue
        const ids = items.map(item => item.id)
        const kinds = [...new Set(items.map(item => item.kind))]
        const link = unsubscribeUrl(tokens.issue({ scope: 'member', subject: key, kinds }))
        const content = notificationEmail({ items, origin: base.origin, unsubscribeUrl: link })
        const idempotencyKey = 'unlinked-notify-' + createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 48)
        try {
          await transport.send(message({ ...content, to: recipient.address, from: service.from, unsubscribeUrl: link, idempotencyKey }))
        } catch (error) {
          result.failed += items.length
          report({ event: 'email_notification_failed', code: code(error) })
          // Rejected for good (bad recipient, unverified sender...): never retried.
          if (permanentFailure(error)) { await notificationStore.markEmailed(ids, { claim, at, outcome: 'failed' }); continue }
          // Otherwise released for a later pass; the same idempotency key stops a double send.
          await notificationStore.releaseEmail(ids, claim).catch(() => {})
          // Throttled or down for everyone: stop this pass and back off.
          if (globalFailure(error)) { pause(error, at); result.paused = true; break }
          // Network trouble: this member backs off on their own.
          const attempts = recipient.retryAttempts ?? 0
          await store.setRetry(key, { retryAfter: at + backoffMs(attempts), attempts: attempts + 1 })
          continue
        }
        pauseAttempts = 0
        await notificationStore.markEmailed(ids, { claim, at, outcome: 'sent' })
        await store.markNotified(key, at)
        result.sent++
      } catch (error) {
        report({ event: 'email_notification_failed', code: code(error) })
      }
    }
    return result
  }
  return service
}

// --- Stores ----------------------------------------------------------------

// Test and preview storage. reserveInvite checks and inserts with no await in
// between, so it is atomic on one event loop, like the graph's locked transaction.
export function createMemoryEmailStore() {
  const recipients = new Map(), suppressed = new Map(), sends = new Map()
  const record = (member, key) => recipients.get(key) ?? recipients.set(key, { accountKey: key, ownerId: member.ownerId, userId: member.userId }).get(key)
  return {
    recipients, suppressed, sends,
    async initialize() {},
    async getRecipient(key) { const value = recipients.get(key); return value ? structuredClone(value) : null },
    async setAddress(member, key, { address, verified, at }) { Object.assign(record(member, key), { address, verified, updatedAt: at }) },
    async noteNewAccount(member, key, at) { const value = record(member, key); value.accountCreatedAt ??= at },
    async setPreferences(member, key, preferences, at) { Object.assign(record(member, key), { preferences, updatedAt: at }) },
    async unsubscribe(key, kinds, at) {
      const value = recipients.get(key)
      if (!value) return
      const preferences = preferencesOf(value)
      for (const kind of kinds) preferences[kind] = false
      Object.assign(value, { preferences: JSON.stringify(preferences), updatedAt: at })
    },
    async markNotified(key, at) { const value = recipients.get(key); if (value) { value.lastNotifiedAt = at; delete value.retryAfter; delete value.retryAttempts } },
    async setRetry(key, { retryAfter, attempts }) { const value = recipients.get(key); if (value) Object.assign(value, { retryAfter, retryAttempts: attempts }) },
    async heldRecipients({ notifiedSince, now, limit }) {
      return [...recipients.values()].filter(value => value.lastNotifiedAt > notifiedSince || value.retryAfter > now).slice(0, limit).map(value => `${value.ownerId}\u0000${value.userId}`)
    },
    async pendingImportReminders({ at, staleClaimBefore, limit }) {
      return [...recipients.values()].filter(value => value.verified && value.accountCreatedAt != null && at - value.accountCreatedAt >= 2 * DAY && at - value.accountCreatedAt < 4 * DAY &&
        (value.importReminderStage ?? 0) < (at - value.accountCreatedAt >= 3 * DAY ? 2 : 1) && (value.retryAfter ?? 0) <= at && (value.importReminderClaim == null || value.importReminderClaimAt < staleClaimBefore))
        .sort((a, b) => a.accountCreatedAt - b.accountCreatedAt).slice(0, limit).map(value => structuredClone(value))
    },
    async claimImportReminder(key, { stage, claim, at, staleClaimBefore, payload }) {
      const value = recipients.get(key)
      if (!value || (value.importReminderStage ?? 0) >= stage || (value.importReminderClaim != null && value.importReminderClaimAt >= staleClaimBefore)) return null
      if (value.importReminderAttemptStage !== stage) { value.importReminderAttemptStage = stage; value.importReminderAttemptAt = at; value.importReminderPayload = payload }
      value.importReminderPayload ??= payload
      Object.assign(value, { importReminderClaim: claim, importReminderClaimAt: at })
      return structuredClone(value)
    },
    async settleImportReminder(key, { stage, claim }) {
      const value = recipients.get(key)
      if (value?.importReminderClaim !== claim) return
      value.importReminderStage = stage
      delete value.importReminderClaim; delete value.importReminderClaimAt
      delete value.retryAfter; delete value.retryAttempts
    },
    async releaseImportReminder(key, claim) {
      const value = recipients.get(key)
      if (value?.importReminderClaim === claim) { delete value.importReminderClaim; delete value.importReminderClaimAt }
    },
    async finishImportReminders(key) {
      const value = recipients.get(key)
      if (value) { value.importReminderStage = 2; delete value.importReminderClaim; delete value.importReminderClaimAt }
    },
    async deleteOwner(key) { recipients.delete(key); for (const [id, value] of sends) if (value.senderKey === key) sends.delete(id) },
    async isSuppressed(hash) { return suppressed.has(hash) },
    async suppress(hash, at) { if (!suppressed.has(hash)) suppressed.set(hash, at) },
    async reserveInvite({ id, senderKey, recipientHash, at, since, recipientSince, pruneBefore, senderLimit, siteLimit }) {
      for (const [key, value] of sends) if (value.at <= pruneBefore) sends.delete(key)
      const values = [...sends.values()], today = values.filter(value => value.at > since)
      if (values.some(value => value.recipientHash === recipientHash && value.at > recipientSince)) return 'recipient'
      if (today.filter(value => value.senderKey === senderKey).length >= senderLimit) return 'member'
      if (today.length >= siteLimit) return 'site'
      sends.set(id, { id, kind: 'invite', senderKey, recipientHash, at })
      return 'ok'
    },
    async releaseSend(id) { sends.delete(id) },
  }
}

const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const RECIPIENT_KEYS = ['accountKey', 'ownerId', 'userId', 'address', 'verified', 'preferences', 'lastNotifiedAt', 'retryAfter', 'retryAttempts', 'accountCreatedAt', 'updatedAt', 'importReminderStage', 'importReminderClaim', 'importReminderClaimAt', 'importReminderAttemptStage', 'importReminderAttemptAt', 'importReminderPayload']
// UnlinkedEmailRecipient / UnlinkedEmailSuppression / UnlinkedEmailSend /
// UnlinkedEmailInviteLock nodes; initialize() only adds their own constraints and indexes.
export function createNeo4jEmailStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  const setRecipient = 'MERGE (e:UnlinkedEmailRecipient {accountKey: $key}) SET e.ownerId = $ownerId, e.userId = $userId'
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_email_recipient_key IF NOT EXISTS FOR (e:UnlinkedEmailRecipient) REQUIRE e.accountKey IS UNIQUE', {})
      await write('CREATE INDEX unlinked_email_recipient_notified IF NOT EXISTS FOR (e:UnlinkedEmailRecipient) ON (e.lastNotifiedAt)', {})
      await write('CREATE INDEX unlinked_email_recipient_created IF NOT EXISTS FOR (e:UnlinkedEmailRecipient) ON (e.accountCreatedAt)', {})
      await write('CREATE INDEX unlinked_email_recipient_retry IF NOT EXISTS FOR (e:UnlinkedEmailRecipient) ON (e.retryAfter)', {})
      await write('CREATE CONSTRAINT unlinked_email_suppression_hash IF NOT EXISTS FOR (e:UnlinkedEmailSuppression) REQUIRE e.recipientHash IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_email_send_id IF NOT EXISTS FOR (e:UnlinkedEmailSend) REQUIRE e.id IS UNIQUE', {})
      await write('CREATE INDEX unlinked_email_send_sender IF NOT EXISTS FOR (e:UnlinkedEmailSend) ON (e.senderKey)', {})
      await write('CREATE INDEX unlinked_email_send_recipient IF NOT EXISTS FOR (e:UnlinkedEmailSend) ON (e.recipientHash)', {})
      await write('CREATE INDEX unlinked_email_send_at IF NOT EXISTS FOR (e:UnlinkedEmailSend) ON (e.at)', {})
      await write('CREATE CONSTRAINT unlinked_email_invite_lock_id IF NOT EXISTS FOR (e:UnlinkedEmailInviteLock) REQUIRE e.id IS UNIQUE', {})
    },
    async getRecipient(key) {
      const result = await read('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) RETURN properties(e) AS e', { key })
      if (!result.records.length) return null
      const properties = result.records[0].get('e'), value = {}
      for (const name of RECIPIENT_KEYS) if (properties[name] != null) value[name] = number(properties[name])
      return value
    },
    async setAddress(member, key, { address, verified, at }) {
      await write(`${setRecipient}, e.address = $address, e.verified = $verified, e.updatedAt = $at`, { key, ownerId: member.ownerId, userId: member.userId, address, verified, at })
    },
    async noteNewAccount(member, key, at) {
      await write(`${setRecipient}, e.accountCreatedAt = coalesce(e.accountCreatedAt, $at)`, { key, ownerId: member.ownerId, userId: member.userId, at })
    },
    async setPreferences(member, key, preferences, at) {
      await write(`${setRecipient}, e.preferences = $preferences, e.updatedAt = $at`, { key, ownerId: member.ownerId, userId: member.userId, preferences, at })
    },
    async unsubscribe(key, kinds, at) {
      const session = driver.session({ database })
      try {
        await session.executeWrite(async tx => {
          const result = await tx.run('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e._emailLock = coalesce(e._emailLock, 0) + 1 RETURN e.preferences AS preferences', { key })
          if (!result.records.length) return
          const preferences = preferencesOf({ preferences: result.records[0].get('preferences') })
          for (const kind of kinds) preferences[kind] = false
          await tx.run('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e.preferences = $preferences, e.updatedAt = $at', { key, preferences: JSON.stringify(preferences), at })
        })
      } finally { await session.close() }
    },
    async markNotified(key, at) { await write('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e.lastNotifiedAt = $at REMOVE e.retryAfter, e.retryAttempts', { key, at }) },
    async setRetry(key, { retryAfter, attempts }) { await write('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e.retryAfter = $retryAfter, e.retryAttempts = $attempts', { key, retryAfter, attempts }) },
    async heldRecipients({ notifiedSince, now, limit }) {
      const result = await read(`MATCH (e:UnlinkedEmailRecipient) WHERE e.lastNotifiedAt > $notifiedSince OR e.retryAfter > $now RETURN e.ownerId AS ownerId, e.userId AS userId LIMIT ${Math.min(Math.max(Number(limit) | 0, 1), 100000)}`, { notifiedSince, now })
      return result.records.map(record => `${record.get('ownerId')}\u0000${record.get('userId')}`)
    },
    async pendingImportReminders({ at, staleClaimBefore, limit }) {
      const result = await read(`MATCH (e:UnlinkedEmailRecipient) WHERE e.verified = true AND e.accountCreatedAt <= $at - $twoDays AND e.accountCreatedAt > $at - $fourDays
        AND coalesce(e.importReminderStage, 0) < CASE WHEN e.accountCreatedAt <= $at - $threeDays THEN 2 ELSE 1 END
        AND coalesce(e.retryAfter, 0) <= $at AND (e.importReminderClaim IS NULL OR e.importReminderClaimAt < $staleClaimBefore)
        RETURN properties(e) AS e ORDER BY e.accountCreatedAt LIMIT ${Math.min(Math.max(Number(limit) | 0, 1), 1000)}`,
        { at, staleClaimBefore, twoDays: 2 * DAY, threeDays: 3 * DAY, fourDays: 4 * DAY })
      return result.records.map(record => Object.fromEntries(Object.entries(record.get('e')).filter(([key]) => RECIPIENT_KEYS.includes(key)).map(([key, value]) => [key, number(value)])))
    },
    async claimImportReminder(key, { stage, claim, at, staleClaimBefore, payload }) {
      const result = await write(`MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e._emailLock = coalesce(e._emailLock, 0) + 1
        WITH e WHERE coalesce(e.importReminderStage, 0) < $stage AND (e.importReminderClaim IS NULL OR e.importReminderClaimAt < $staleClaimBefore)
        SET e.importReminderPayload = CASE WHEN e.importReminderAttemptStage = $stage THEN coalesce(e.importReminderPayload, $payload) ELSE $payload END,
          e.importReminderAttemptAt = CASE WHEN e.importReminderAttemptStage = $stage THEN e.importReminderAttemptAt ELSE $at END,
          e.importReminderAttemptStage = $stage, e.importReminderClaim = $claim, e.importReminderClaimAt = $at
        RETURN properties(e) AS e`, { key, stage, claim, at, staleClaimBefore, payload })
      const value = result.records[0]?.get('e')
      return value ? Object.fromEntries(Object.entries(value).filter(([key]) => RECIPIENT_KEYS.includes(key)).map(([key, value]) => [key, number(value)])) : null
    },
    async settleImportReminder(key, { stage, claim }) {
      await write(`MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e._emailLock = coalesce(e._emailLock, 0) + 1
        WITH e WHERE e.importReminderClaim = $claim SET e.importReminderStage = $stage
        REMOVE e.importReminderClaim, e.importReminderClaimAt, e.retryAfter, e.retryAttempts`, { key, stage, claim })
    },
    async releaseImportReminder(key, claim) {
      await write(`MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e._emailLock = coalesce(e._emailLock, 0) + 1
        WITH e WHERE e.importReminderClaim = $claim REMOVE e.importReminderClaim, e.importReminderClaimAt`, { key, claim })
    },
    async finishImportReminders(key) {
      await write(`MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) SET e._emailLock = coalesce(e._emailLock, 0) + 1, e.importReminderStage = 2
        REMOVE e.importReminderClaim, e.importReminderClaimAt`, { key })
    },
    async deleteOwner(key) {
      await write('MATCH (e:UnlinkedEmailRecipient {accountKey: $key}) DETACH DELETE e', { key })
      await write('MATCH (e:UnlinkedEmailSend {senderKey: $key}) DETACH DELETE e', { key })
    },
    async isSuppressed(hash) { return (await read('MATCH (e:UnlinkedEmailSuppression {recipientHash: $hash}) RETURN e.recipientHash AS hash', { hash })).records.length > 0 },
    async suppress(hash, at) { await write('MERGE (e:UnlinkedEmailSuppression {recipientHash: $hash}) ON CREATE SET e.at = $at', { hash, at }) },
    // One write transaction: take the single invite lock, recount, create only
    // under every limit. Concurrent reservations serialize on the lock node.
    async reserveInvite({ id, senderKey, recipientHash, at, since, recipientSince, pruneBefore, senderLimit, siteLimit }) {
      const session = driver.session({ database })
      try {
        return await session.executeWrite(async tx => {
          await tx.run("MERGE (l:UnlinkedEmailInviteLock {id: 'invite-emails'}) SET l._lock = coalesce(l._lock, 0) + 1", {})
          await tx.run('MATCH (e:UnlinkedEmailSend) WHERE e.at <= $pruneBefore WITH e LIMIT 1000 DETACH DELETE e', { pruneBefore })
          const recipient = await tx.run('MATCH (e:UnlinkedEmailSend {recipientHash: $recipientHash}) WHERE e.at > $recipientSince RETURN count(e) AS count', { recipientHash, recipientSince })
          if (Number(number(recipient.records[0]?.get('count')) ?? 0) > 0) return 'recipient'
          const counts = await tx.run('MATCH (e:UnlinkedEmailSend) WHERE e.at > $since RETURN count(e) AS site, sum(CASE WHEN e.senderKey = $senderKey THEN 1 ELSE 0 END) AS sender', { since, senderKey })
          if (Number(number(counts.records[0]?.get('sender')) ?? 0) >= senderLimit) return 'member'
          if (Number(number(counts.records[0]?.get('site')) ?? 0) >= siteLimit) return 'site'
          await tx.run("CREATE (e:UnlinkedEmailSend) SET e = {id: $id, kind: 'invite', senderKey: $senderKey, recipientHash: $recipientHash, at: $at}", { id, senderKey, recipientHash, at })
          return 'ok'
        })
      } finally { await session.close() }
    },
    async releaseSend(id) { await write('MATCH (e:UnlinkedEmailSend {id: $id}) DETACH DELETE e', { id }) },
  }
}
