import { randomInt } from 'node:crypto'

// A member's contact card: the business-card version of their profile, with
// the phone number, WhatsApp, email address and link they choose to show.
//
// Privacy model:
// - Nothing here is ever part of the public profile, the People index, search,
//   model context or the agent API. The details exist only on this card.
// - The card is reached through a random link (/c/<token>) that the member
//   hands over themselves, usually as a QR code. The token is unrelated to any
//   account or profile id, so it cannot be derived from a public page.
// - Every field has its own show switch, off until the member turns it on.
//   With nothing shown the link answers as not found.
// - Resetting the link issues a new token; every earlier link and QR stops
//   working at once.
//
// The route and token grammar (/c/ + 24 alphanumerics) and the per-field
// `show…` switches match OpenChat's AddMe card, so one scanner reads both and
// the two card shapes can converge. See docs/contact-card.md.
export const CONTACT_CARD_TOKEN = /^[0-9A-Za-z]{24}$/
export const CONTACT_CARD_FIELDS = Object.freeze(['phone', 'whatsapp', 'email', 'link'])
const SHOW = Object.freeze({ phone: 'showPhone', whatsapp: 'showWhatsapp', email: 'showEmail', link: 'showLink' })
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LINK_MAX = 200
const PROFILE_PATH = /^\/people\/[A-Za-z0-9._~%-]{1,480}$/

export class ContactCardError extends Error {
  constructor(code) { super(code); this.code = code }
}
const owner = value => {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.userId !== 'string' || !value.userId) throw new ContactCardError('contact_card_owner_required')
  return value
}
const ownerKey = member => `${member.ownerId}\n${member.userId}`
// 24 characters from 62 is about 143 bits: not guessable, and alphanumeric only
// so it survives QR scanners and chat-app autolinkers.
export const generateContactCardToken = () => Array.from({ length: 24 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
const text = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''

// A phone number in international form (E.164): a plus sign, the country code
// and the number. Spaces, dots, dashes and brackets are accepted and dropped.
export function normalizePhone(value, code = 'contact_phone_invalid') {
  const typed = text(value)
  if (!typed) return null
  if (/[^0-9+().\-\s]/.test(typed)) throw new ContactCardError(code)
  const digits = typed.replace(/[().\-\s]/g, '')
  if (!/^\+[1-9][0-9]{6,14}$/.test(digits)) throw new ContactCardError(code)
  return digits
}
// North American numbers read as +1 (415) 555-0123; the rest stay as stored.
export const displayPhone = value => typeof value === 'string' && /^\+1[0-9]{10}$/.test(value) ? `+1 (${value.slice(2, 5)}) ${value.slice(5, 8)}-${value.slice(8)}` : typeof value === 'string' ? value : ''
export const whatsappUrl = value => `https://wa.me/${value.slice(1)}`
export function normalizeEmail(value) {
  const typed = text(value)
  if (!typed) return null
  if (typed.length > 254 || !/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,24}$/.test(typed) || typed.includes('..')) throw new ContactCardError('contact_email_invalid')
  return typed
}
export function isSafeContactLink(value) {
  if (typeof value !== 'string' || value.length > LINK_MAX || /[\u0000-\u0020\u007f<>"'\\]/.test(value)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') } catch { return false }
}
export function normalizeLink(value) {
  let typed = text(value)
  if (!typed) return null
  if (/^http:\/\//i.test(typed)) typed = typed.replace(/^http:/i, 'https:')
  else if (!/^https:\/\//i.test(typed)) typed = `https://${typed}`
  if (!isSafeContactLink(typed)) throw new ContactCardError('contact_link_invalid')
  return new URL(typed).href
}
// Who the card is for: the member's own public professional identity, kept
// with the card so the link can be opened without the member's session.
const plain = (value, max) => { const typed = text(value); return typed && [...typed].length <= max && !/[\u0000-\u001f\u007f]/.test(typed) ? typed : null }
// A `profilePath` left undefined means "not known right now" (the public index
// could not be read): the stored one is kept rather than cleared.
const identityOf = (value, existing) => ({ name: plain(value?.name, 120), headline: plain(value?.headline, 220), location: plain(value?.location, 120),
  profilePath: value?.profilePath === undefined && existing ? existing.profilePath ?? null : typeof value?.profilePath === 'string' && PROFILE_PATH.test(value.profilePath) ? value.profilePath : null })
const IDENTITY_KEYS = ['name', 'headline', 'location', 'profilePath']

const settingsOf = record => ({ phone: record?.phone ?? null, showPhone: record?.showPhone === true, whatsapp: record?.whatsapp ?? null, showWhatsapp: record?.showWhatsapp === true,
  email: record?.email ?? null, showEmail: record?.showEmail === true, link: record?.link ?? null, showLink: record?.showLink === true })

/**
 * Exactly what someone holding the link may see. Pure, so the matrix of what a
 * card does and does not reveal is tested without a database. A WhatsApp switch
 * with no separate WhatsApp number uses the phone number. Returns null when
 * nothing is shown: the card then does not exist for anyone but its owner.
 */
export function projectContactCard(record) {
  if (!record) return null
  const settings = settingsOf(record)
  const phone = settings.showPhone && settings.phone ? settings.phone : null
  const whatsappNumber = settings.showWhatsapp ? settings.whatsapp ?? settings.phone : null
  const email = settings.showEmail && settings.email ? settings.email : null
  const link = settings.showLink && settings.link && isSafeContactLink(settings.link) ? settings.link : null
  if (!phone && !whatsappNumber && !email && !link) return null
  return { ...identityOf(record), phone, whatsapp: whatsappNumber ?? null, email, link }
}

export function createContactCards({ store, now = Date.now } = {}) {
  if (!store || ['get', 'getByToken', 'put', 'setIdentity', 'delete'].some(name => typeof store[name] !== 'function')) throw new Error('contact_card_store_required')
  const view = record => ({ token: record.token, settings: settingsOf(record), card: projectContactCard(record) })
  return {
    // The owner's own view: their settings, and the link once a card exists.
    async read(member) {
      const record = await store.get(owner(member))
      return record ? view(record) : null
    },
    // Saves the details and their show switches. The link is created with the
    // first save and stays the same until it is reset.
    async save(member, input = {}, identity = {}) {
      owner(member)
      const fields = { phone: normalizePhone(input.phone), whatsapp: normalizePhone(input.whatsapp, 'contact_whatsapp_invalid'), email: normalizeEmail(input.email), link: normalizeLink(input.link) }
      const shows = { showPhone: input.showPhone === true && fields.phone !== null, showWhatsapp: input.showWhatsapp === true && (fields.whatsapp ?? fields.phone) !== null,
        showEmail: input.showEmail === true && fields.email !== null, showLink: input.showLink === true && fields.link !== null }
      const existing = await store.get(member)
      const at = now()
      const record = { ownerKey: ownerKey(member), ownerId: member.ownerId, userId: member.userId, token: existing?.token ?? generateContactCardToken(), ...fields, ...shows, ...identityOf(identity, existing), createdAt: existing?.createdAt ?? at, updatedAt: at }
      await store.put(record)
      return view(record)
    },
    // A new link; every earlier link and QR code stops working.
    async rotate(member) {
      const existing = await store.get(owner(member))
      if (!existing) throw new ContactCardError('contact_card_not_found')
      const record = { ...existing, token: generateContactCardToken(), updatedAt: now() }
      await store.put(record)
      return view(record)
    },
    // Keeps the name, headline and public profile link on the card current.
    async syncIdentity(member, identity) {
      const existing = await store.get(owner(member))
      if (!existing) return false
      const next = identityOf(identity, existing)
      if (IDENTITY_KEYS.every(key => (existing[key] ?? null) === next[key])) return false
      // Only the identity is written: a reset or a hidden field saved at the
      // same moment is never overwritten by this page view.
      await store.setIdentity(member, next)
      return true
    },
    // What the link shows, or null: unknown, reset, or nothing shown.
    async open(token) {
      if (typeof token !== 'string' || !CONTACT_CARD_TOKEN.test(token)) return null
      return projectContactCard(await store.getByToken(token))
    },
    // Server-only bearer capability. Never included in the card projection.
    // Recheck visibility and token rotation at the time of connecting.
    async ownerForToken(token) {
      if (typeof token !== 'string' || !CONTACT_CARD_TOKEN.test(token)) return null
      const record = await store.getByToken(token)
      return projectContactCard(record) ? { ownerId: record.ownerId, userId: record.userId } : null
    },
    // The member's own copy for their data export: details and switches, no link.
    async exportOwner(member) {
      const record = await store.get(owner(member))
      return record ? { ...settingsOf(record), createdAt: record.createdAt, updatedAt: record.updatedAt } : null
    },
    async removeOwner(member) { return store.delete(owner(member)) },
  }
}

export function createMemoryContactCardStore() {
  const records = new Map()
  return {
    records,
    async get(member) { const value = records.get(ownerKey(member)); return value ? structuredClone(value) : null },
    async getByToken(token) { const value = [...records.values()].find(record => record.token === token); return value ? structuredClone(value) : null },
    async put(record) { records.set(record.ownerKey, structuredClone(record)) },
    async setIdentity(member, identity) { const value = records.get(ownerKey(member)); if (value) for (const key of IDENTITY_KEYS) { if (identity[key] === null) delete value[key]; else value[key] = identity[key] } },
    async delete(member) { return records.delete(ownerKey(member)) ? 1 : 0 },
  }
}

const RECORD_KEYS = ['ownerKey', 'ownerId', 'userId', 'token', 'phone', 'showPhone', 'whatsapp', 'showWhatsapp', 'email', 'showEmail', 'link', 'showLink', 'name', 'headline', 'location', 'profilePath', 'createdAt', 'updatedAt']
const fromNode = properties => {
  const value = {}
  for (const name of RECORD_KEYS) if (properties[name] !== undefined && properties[name] !== null) value[name] = typeof properties[name]?.toNumber === 'function' ? properties[name].toNumber() : properties[name]
  if (typeof value.token !== 'string' || !CONTACT_CARD_TOKEN.test(value.token)) throw new Error('contact_card_record_invalid')
  return value
}

// UnlinkedContactCard nodes in the pilot graph, one per account; initialize()
// is additive and idempotent.
export function createNeo4jContactCardStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  const one = result => result.records.length ? fromNode(result.records[0].get('c')) : null
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_contact_card_owner IF NOT EXISTS FOR (c:UnlinkedContactCard) REQUIRE c.ownerKey IS UNIQUE', {})
      await write('CREATE CONSTRAINT unlinked_contact_card_token IF NOT EXISTS FOR (c:UnlinkedContactCard) REQUIRE c.token IS UNIQUE', {})
    },
    async get(member) { return one(await read('MATCH (c:UnlinkedContactCard {ownerKey: $ownerKey}) RETURN properties(c) AS c', { ownerKey: ownerKey(member) })) },
    async getByToken(token) { return one(await read('MATCH (c:UnlinkedContactCard {token: $token}) RETURN properties(c) AS c', { token })) },
    // The whole record replaces the stored one, so a cleared field is removed.
    async put(record) {
      const stored = Object.fromEntries(RECORD_KEYS.filter(name => record[name] !== undefined && record[name] !== null).map(name => [name, record[name]]))
      await write('MERGE (c:UnlinkedContactCard {ownerKey: $ownerKey}) SET c = $stored', { ownerKey: record.ownerKey, stored })
    },
    // Setting a property to null removes it.
    async setIdentity(member, identity) {
      await write('MATCH (c:UnlinkedContactCard {ownerKey: $ownerKey}) SET c.name = $name, c.headline = $headline, c.location = $location, c.profilePath = $profilePath', { ownerKey: ownerKey(member), ...Object.fromEntries(IDENTITY_KEYS.map(key => [key, identity[key] ?? null])) })
    },
    async delete(member) {
      const result = await write('MATCH (c:UnlinkedContactCard {ownerKey: $ownerKey}) WITH c, c.ownerKey AS key DETACH DELETE c RETURN count(key) AS removed', { ownerKey: ownerKey(member) })
      const removed = result.records[0]?.get('removed')
      return typeof removed?.toNumber === 'function' ? removed.toNumber() : Number(removed ?? 0)
    },
  }
}

// vCard 3.0 for "Save contact". Receives only the projection a link holder may
// see. Line endings are normalized before escaping so no field can introduce
// another vCard property.
const vcardText = value => [...String(value).replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\n')].filter(character => { const code = character.codePointAt(0); return code === 10 || (code >= 32 && (code < 127 || code > 159)) }).join('')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
const fold = line => {
  let result = '', bytes = 0
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > 75) { result += '\r\n '; bytes = 1 }
    result += character; bytes += size
  }
  return result
}
export function renderContactVcard(card, origin) {
  const name = vcardText(card.name ?? '') || 'Unlinked member'
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${name};;;`, `FN:${name}`]
  if (card.headline) lines.push(`TITLE:${vcardText(card.headline)}`)
  if (card.phone) lines.push(`TEL;TYPE=CELL:${card.phone}`)
  if (card.whatsapp && card.whatsapp !== card.phone) lines.push(`TEL;TYPE=CELL:${card.whatsapp}`)
  if (card.email) lines.push(`EMAIL;TYPE=INTERNET:${vcardText(card.email)}`)
  if (card.link && isSafeContactLink(card.link)) lines.push(`URL:${card.link}`)
  if (card.whatsapp) lines.push(`URL:${whatsappUrl(card.whatsapp)}`)
  if (card.profilePath && PROFILE_PATH.test(card.profilePath)) lines.push(`URL:${origin}${card.profilePath}`)
  lines.push('END:VCARD')
  return `${lines.map(fold).join('\r\n')}\r\n`
}
