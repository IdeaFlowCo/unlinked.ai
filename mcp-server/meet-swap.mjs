import { randomUUID } from 'node:crypto'
import { normalizeEmail, normalizePhone } from './contact-card.mjs'

export const MEET_ID = /^[a-f0-9-]{36}$/
export const MEET_EVENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CONTACT_CHANNELS = ['phone', 'instagram', 'x', 'linkedin', 'email']
const LIMIT = { links: 40, contacts: 1000, encounters: 2000 }
const empty = () => ({ links: [], contacts: [], encounters: [] })
const ownerKey = ({ ownerId, userId }) => JSON.stringify([ownerId, userId])

export class MeetError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function oneLine(value, max) {
  if (value == null) return ''
  const trimmed = value.normalize('NFKC').trim()
  if (trimmed.length > max || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(trimmed) || !trimmed.isWellFormed()) {
    throw new MeetError(400, 'Keep each answer on one line and within its length limit.')
  }
  return trimmed.replace(/\s+/gu, ' ')
}

const socials = {
  instagram: { hosts: ['instagram.com'], path: /^\/([a-z0-9._]{1,30})\/?$/i, handle: /^[a-z0-9._]{1,30}$/i, reserved: /^(?:p|reels?|stories|explore|accounts|direct|about|tv)$/i },
  x: { hosts: ['x.com', 'twitter.com'], path: /^\/([a-z0-9_]{1,15})\/?$/i, handle: /^[a-z0-9_]{1,15}$/i, reserved: /^(?:home|explore|i|messages|search|settings|intent|share)$/i },
  linkedin: { hosts: ['linkedin.com'], path: /^\/in\/([a-z0-9_-]{1,100})\/?$/i, handle: /^[a-z0-9_-]{1,100}$/i },
}
export function socialHandle(channel, value) {
  const clean = oneLine(value, 300)
  if (!clean) return ''
  const rules = socials[channel]
  let handle = clean.replace(/^@/, '')
  if (clean.includes('/') || clean.includes('://')) {
    let url
    try { url = new URL(/^https?:\/\//i.test(clean) ? clean : 'https://' + clean) } catch {}
    const host = url?.hostname.replace(/^(?:www\.|m\.|mobile\.)/, '')
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !rules.hosts.includes(host)) handle = ''
    else {
      try { handle = rules.path.exec(decodeURIComponent(url.pathname))?.[1] ?? '' } catch { handle = '' }
    }
  }
  if (!rules.handle.test(handle) || rules.reserved?.test(handle) || /^\.+$/.test(handle)) {
    throw new MeetError(400, 'Use a valid Instagram, X or LinkedIn handle or profile link.')
  }
  return handle.toLowerCase()
}

export function parseSwap(input, link) {
  let phone, email
  const typed = oneLine(input.get('phone'), 40)
  try {
    const digits = typed.replace(/[ ().-]/g, '')
    phone = normalizePhone(/^\d{10}$/.test(digits) ? '+1' + digits : /^1\d{10}$/.test(digits) ? '+' + digits : typed)
  } catch { throw new MeetError(400, 'Enter a phone number with its country code, such as +1 415 555 0123.') }
  try { email = normalizeEmail(input.get('email'))?.toLowerCase() } catch { throw new MeetError(400, 'Enter a valid email address.') }
  const channels = Object.fromEntries(Object.entries({
    phone, instagram: socialHandle('instagram', input.get('instagram')), x: socialHandle('x', input.get('x')),
    linkedin: socialHandle('linkedin', input.get('linkedin')), email,
  }).filter(([, value]) => value))
  if (!Object.keys(channels).length) throw new MeetError(400, 'Share at least one way to reach you.')
  const id = input.get('submission')
  if (!MEET_ID.test(id ?? '')) throw new MeetError(400, 'Open the QR link again before swapping.')
  return { id, channels, name: oneLine(input.get('name'), 100), about: oneLine(input.get('about'), 180),
    ask: oneLine(input.get('ask'), 180), invite: input.get('invite') === 'yes', group: link.group && input.get('join') === 'yes' ? link.group.id : null }
}

export function createMeetSwap({ store, now = Date.now }) {
  const links = async owner => (await store.read(owner)).links
  const read = async owner => store.read(owner)
  return {
    read,
    async link(owner, token, event) {
      return (await links(owner)).find(link => link.token === token && link.event === event && link.active) ?? null
    },
    async createLink(owner, token, { label, instagram, x, group }) {
      const event = label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 35).replace(/-$/, '') || 'meet'
      return store.change(owner, data => {
        const link = { token, event: event + '-' + randomUUID().slice(0, 8), label, instagram, x, group, active: true }
        data.links = data.links.filter(item => item.active && item.token === token)
        if (data.links.length >= LIMIT.links) throw new MeetError(409, 'Turn off an earlier QR link before creating another.')
        data.links.unshift(link)
        return link
      })
    },
    async disableLink(owner, event) {
      await store.change(owner, data => { data.links = data.links.filter(link => link.event !== event) }, { existing: true })
    },
    async capture(owner, link, values) {
      return store.change(owner, data => {
        if (!data.links.some(row => row.active && row.token === link.token && row.event === link.event)) throw new MeetError(404, 'This swap link has closed.')
        const seen = data.encounters.find(row => row.id === values.id)
        if (seen) {
          if (seen.event !== link.event) throw new MeetError(409, 'Open this QR link again before swapping.')
          return { duplicate: true, encounter: seen }
        }
        // An unverified submission may extend one matching card. It cannot
        // overwrite a saved channel or combine two people by claiming both.
        const matches = data.contacts.filter(row => CONTACT_CHANNELS.some(key => values.channels[key] && row.channels[key] === values.channels[key]))
        const matched = matches.length === 1 ? matches[0] : null
        const conflict = matches.length > 1 || Boolean(matched && CONTACT_CHANNELS.some(key => matched.channels[key] && values.channels[key] && matched.channels[key] !== values.channels[key]))
        const contact = conflict ? null : matched ?? { id: randomUUID(), name: values.name, channels: {}, note: '' }
        if ((!matched && !conflict && data.contacts.length >= LIMIT.contacts) || data.encounters.length >= LIMIT.encounters) {
          throw new MeetError(409, 'This swap list is full. Ask the host for another way to stay in touch.')
        }
        const at = now()
        if (contact) {
          contact.name ||= values.name
          contact.channels = { ...contact.channels, ...values.channels }
          contact.updatedAt = at
          if (!matched) data.contacts.unshift(contact)
        }
        const encounter = { ...values, event: link.event, eventLabel: link.label, at, contactId: contact?.id ?? null, action: conflict ? 'conflict' : matched ? 'matched' : 'new' }
        data.encounters.unshift(encounter)
        return { contact, encounter }
      }, { existing: true })
    },
    async note(owner, id, note) {
      return store.change(owner, data => {
        const contact = data.contacts.find(row => row.id === id)
        if (!contact) throw new MeetError(404, 'This contact is unavailable.')
        contact.note = note
      }, { existing: true })
    },
    async recordAsk(owner, contactId, encounterId, authorId, askId) {
      return store.change(owner, data => {
        const contact = data.contacts.find(row => row.id === contactId)
        const encounter = encounterId ? data.encounters.find(row => row.id === encounterId && row.contactId === contactId) : null
        if (!contact || (encounterId && !encounter)) return
        contact.authorId = authorId
        if (encounter) encounter.askId = askId
      }, { existing: true })
    },
    async exportOwner(owner) {
      const { contacts, encounters, links } = await read(owner)
      if (!links.length && !encounters.length) return null
      return { contacts, encounters, links: links.map(({ token, group, ...link }) => ({ ...link, group: group?.id })) }
    },
    removeOwner: store.remove,
  }
}

export function createMemoryMeetStore() {
  const records = new Map()
  return {
    async read(owner) { return structuredClone(records.get(ownerKey(owner)) ?? empty()) },
    async change(owner, change, { existing = false } = {}) {
      const key = ownerKey(owner), value = structuredClone(records.get(key) ?? empty())
      if (existing && !records.has(key)) throw new MeetError(404, 'This swap link has closed.')
      const result = change(value)
      records.set(key, value)
      return structuredClone(result)
    },
    async remove(owner) { records.delete(ownerKey(owner)) },
  }
}

export function createNeo4jMeetStore(driver, database = 'neo4j') {
  const run = async (write, work) => {
    const session = driver.session({ database, defaultAccessMode: write ? 'WRITE' : 'READ' })
    try { return await (write ? session.executeWrite(work) : session.executeRead(work)) } finally { await session.close() }
  }
  const read = result => JSON.parse(result.records[0]?.get('data') ?? JSON.stringify(empty()))
  return {
    async initialize() {
      await run(true, tx => tx.run('CREATE CONSTRAINT unlinked_meet_owner IF NOT EXISTS FOR (m:UnlinkedMeetSwap) REQUIRE m.ownerKey IS UNIQUE'))
    },
    async read(owner) {
      return run(false, async tx => read(await tx.run('MATCH (m:UnlinkedMeetSwap {ownerKey: $key}) RETURN m.data AS data', { key: ownerKey(owner) })))
    },
    async change(owner, change, { existing = false } = {}) {
      const key = ownerKey(owner)
      return run(true, async tx => {
        const locked = await tx.run(`${existing ? 'MATCH' : 'MERGE'} (m:UnlinkedMeetSwap {ownerKey: $key}) SET m._lock = true REMOVE m._lock RETURN m.data AS data`, { key })
        if (!locked.records.length) throw new MeetError(404, 'This swap link has closed.')
        const data = read(locked), result = change(data)
        await tx.run('MATCH (m:UnlinkedMeetSwap {ownerKey: $key}) SET m.data = $data', { key, data: JSON.stringify(data) })
        return result
      })
    },
    async remove(owner) {
      await run(true, tx => tx.run('MATCH (m:UnlinkedMeetSwap {ownerKey: $key}) DELETE m', { key: ownerKey(owner) }))
    },
  }
}
