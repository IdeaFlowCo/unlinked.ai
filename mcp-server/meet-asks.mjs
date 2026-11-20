import { OPENCHAT_ORIGIN } from './messaging-proxy.mjs'
import { MeetError, oneLine } from './meet-swap.mjs'

const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[\x00-\x20\x7f/\\]/.test(id) && id.isWellFormed()
const statuses = ['open', 'stale', 'fulfilled', 'withdrawn']
const day = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : ''
const sourceOf = label => ['QR swap', 'Dictated', 'Typed'].includes(label) ? label : 'OpenChat'

// Same OpenChat endpoints as oc_save_ask, oc_list_asks and oc_update_ask.
// No browser-supplied credential, owner id, exposure or upstream URL.
export function createMeetAsks({ createMessagingSession, fetchImpl = fetch }) {
  async function withOwner(session, operation) {
    try {
      const { token } = await createMessagingSession(session)
      if (!token) throw new Error('missing credential')
      return await operation(async (path, method = 'GET', data) => {
        const response = await fetchImpl(OPENCHAT_ORIGIN + '/api/private' + path, {
          method, redirect: 'error', signal: AbortSignal.timeout(4000),
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) },
          ...(data ? { body: JSON.stringify(data) } : {}),
        })
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 404) throw new MeetError(404, 'That person or ask is no longer available.')
          if (response.status === 429) throw new MeetError(429, 'Try again in a moment.')
          throw new Error('ask request failed')
        }
        const raw = await response.text()
        if (raw.length > 1_000_000) throw new Error('ask response too large')
        return JSON.parse(raw)
      })
    } catch (error) {
      if (error instanceof MeetError) throw error
      throw new MeetError(503, 'OpenChat asks are temporarily unavailable. Try again shortly.')
    }
  }
  function askView(ask) {
    if (!validId(ask?.id) || typeof ask.text !== 'string' || !statuses.includes(ask.status)) throw new Error('invalid ask')
    return { id: ask.id, text: ask.text, person: ask.authorParty?.name || 'Someone in your network',
      partyId: ask.authorParty?.id ?? null, source: sourceOf(ask.evidence?.label), date: day(ask.createdAt), status: ask.status }
  }
  const save = async (call, author, text, source, at = Date.now()) => {
    const result = await call('/asks', 'POST', { author, text, exposure: 'only_me', evidence: { label: source, seenAt: new Date(at).toISOString() } })
    return askView(result.ask)
  }
  const resolveContact = async (call, contact) => {
    if (validId(contact.authorId)) return contact.authorId
    const result = await call('/things/resolve', 'POST', { kind: 'person', name: contact.name || 'Contact from QR swap',
      createNew: true, clientRequestId: contact.id })
    if (!validId(result.id)) throw new Error('invalid private person')
    return result.id
  }
  return {
    forOwner(session, person = null) {
      return withOwner(session, async call => {
        const filter = person ? { askerKind: person.kind, askerId: person.id, status: 'all' } : { direction: 'from_others', status: 'open,stale' }
        const result = await call('/asks?' + new URLSearchParams({ ...filter, limit: '100' }))
        if (!Array.isArray(result.asks)) throw new Error('invalid asks')
        return { asks: result.asks.slice(0, 100).map(askView), truncated: result.truncated === true }
      })
    },
    findPeople(session, name) {
      return withOwner(session, async call => {
        const result = await call('/things?' + new URLSearchParams({ kind: 'person', q: name, summary: 'true', limit: '50' }))
        if (result.nextCursor) throw new MeetError(400, 'Many saved people match. Use a full name or open the person’s page.')
        if (!Array.isArray(result.things)) throw new Error('invalid people')
        return result.things.filter(person => person.kind === 'person' && validId(person.id) && typeof person.name === 'string' && sameName(person.name, name))
          .map(person => ({ kind: 'thing', id: person.id, name: person.name, detail: person.description?.slice(0, 100) || 'OpenChat contact' }))
      })
    },
    saveForContact(session, contact, text, source, at) {
      return withOwner(session, async call => {
        const id = await resolveContact(call, contact)
        return { authorId: id, ask: await save(call, { kind: 'thing', id }, text, source, at) }
      })
    },
    save(session, { kind, id }, text, source) {
      return withOwner(session, call => save(call, { kind, id }, text, source))
    },
    update(session, id, status) {
      if (!validId(id) || !['open', 'stale', 'fulfilled'].includes(status)) throw new MeetError(400, 'Choose a valid ask status.')
      return withOwner(session, async call => askView((await call('/asks/' + encodeURIComponent(id), 'PATCH', { status })).ask))
    },
  }
}

const nameKey = name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
export function sameName(name, query) {
  const full = nameKey(name), key = nameKey(query)
  return full === key || (!key.includes(' ') && full.split(' ')[0] === key)
}

export function parseAskDraft(input, context) {
  const text = oneLine(input, 240)
  const explicit = /^(.{1,100}?)\s+(?:needs?|is looking for|could use)\s+(.+)$/iu.exec(text)
  if (explicit) return { name: explicit[1], text: oneLine(explicit[2], 180), useContext: Boolean(context && sameName(context.name, explicit[1])) }
  if (context && text) return { name: context.name, text: oneLine(text.replace(/^(?:needs?|looking for|could use)\s+/i, ''), 180), useContext: true }
  throw new MeetError(400, 'Say or type a name and what they need, such as “Maya needs a cofounder.”')
}

const themes = [
  ['Jobs & hiring', /\b(?:jobs?|hiring|recruit(?:er|ing)?|role|work|internship)\b/i],
  ['Founders & funding', /\b(?:cofounder|co-founder|founder|investor|funding|fundraise|capital)\b/i],
  ['Introductions', /\b(?:intro|introductions?|connect(?:ion)?|meet)\b/i],
  ['Housing & places', /\b(?:housing|apartment|roommate|rent|space|venue)\b/i],
]
export const askTheme = text => themes.find(([, pattern]) => pattern.test(text))?.[0] ?? 'Other asks'
const stop = new Set(['need', 'needs', 'help', 'could', 'looking', 'someone', 'want', 'with', 'from', 'about', 'intro', 'introduction'])
const keywords = text => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(word => !stop.has(word)))
export function suggestAskHelpers(ask, data) {
  const wanted = keywords(ask.text)
  const matches = new Map()
  for (const { contactId, about } of data.encounters) {
    if (!contactId || !about) continue
    const words = [...keywords(about)].filter(word => wanted.has(word))
    if (words.length > (matches.get(contactId)?.length ?? 0)) matches.set(contactId, words)
  }
  return data.contacts.filter(contact => contact.name && contact.authorId !== ask.partyId && matches.has(contact.id))
    .map(contact => ({ id: contact.id, name: contact.name, words: matches.get(contact.id) }))
    .sort((a, b) => b.words.length - a.words.length || a.name.localeCompare(b.name)).slice(0, 3)
}
