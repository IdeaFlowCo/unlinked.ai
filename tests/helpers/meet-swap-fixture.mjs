import { createHash, randomUUID } from 'node:crypto'
import { createContactCards, createMemoryContactCardStore } from '../../mcp-server/contact-card.mjs'
import { createCollectiveGroups } from '../../mcp-server/collective-groups.mjs'
import { createMemoryCollectiveGroupsStore } from '../../mcp-server/collective-groups-store.mjs'
import { createMeetAsks } from '../../mcp-server/meet-asks.mjs'
import { createMeetSwap, createMemoryMeetStore } from '../../mcp-server/meet-swap.mjs'
import { createNotifications, createMemoryNotificationStore } from '../../mcp-server/member-notifications.mjs'
import { createPrivateBrowserHandler } from '../../mcp-server/private-browser.mjs'
import { createMemorySessionStore } from '../../mcp-server/session-store.mjs'

export async function meetFixture(baseUrl, { enabled = true, asksEnabled = true } = {}) {
  const members = [
    { ownerId: 'fictional-rivera-owner', userId: 'fictional-rivera-user', displayName: 'Sam Rivera' },
    { ownerId: 'fictional-brooks-owner', userId: 'fictional-brooks-user', displayName: 'Theo Brooks' },
  ].map(member => ({ ...member, sid: randomUUID(), csrf: randomUUID(), subject: member.userId }))
  const [host, other] = members
  const createMessagingSession = async ({ owner }) => ({ token: 'fixture-' + owner.userId })
  const asks = new Map(members.map(member => [member.userId, []]))
  const people = new Map(members.map(member => [member.userId, new Map()]))
  const operations = []
  const upstream = { unavailable: false }
  async function fetchImpl(address, options) {
    const token = options.headers.Authorization.slice('Bearer fixture-'.length)
    const url = new URL(address), method = options.method
    if (!options.headers.Authorization.startsWith('Bearer fixture-') || url.origin !== 'https://chat.ideaflow.app' || !people.has(token)) throw Error('wrong fixture credential')
    if (upstream.unavailable) return Response.json({}, { status: 503 })
    const payload = options.body ? JSON.parse(options.body) : null
    const path = url.pathname, persons = people.get(token), list = asks.get(token)
    operations.push({ token, method, path, payload })
    if (path === '/api/private/things/resolve' && method === 'POST') {
      const id = payload.clientRequestId
      if (!payload.createNew || payload.kind !== 'person') throw Error('unsafe person resolution')
      if (!persons.has(id)) persons.set(id, { kind: 'person', id, name: payload.name })
      return Response.json(persons.get(id))
    }
    if (path === '/api/private/things' && method === 'GET') return Response.json({ things: [...persons.values()] })
    if (path === '/api/private/asks' && method === 'POST') {
      const authorParty = persons.get(payload.author?.id)
      if (payload.exposure !== 'only_me' || !authorParty) return Response.json({}, { status: 404 })
      const previous = list.find(ask => ask.authorParty.id === authorParty.id && ask.text === payload.text)
      if (previous) return Response.json({ ask: previous, created: false })
      const ask = { id: randomUUID(), text: payload.text, authorParty, evidence: payload.evidence, status: 'open', createdAt: new Date().toISOString() }
      list.push(ask)
      return Response.json({ ask, created: true }, { status: 201 })
    }
    if (path === '/api/private/asks' && method === 'GET') {
      const id = url.searchParams.get('askerId'), status = url.searchParams.get('status')
      return Response.json({ asks: list.filter(ask => (!id || ask.authorParty.id === id) && (status === 'all' || status.split(',').includes(ask.status))), truncated: false })
    }
    if (path.startsWith('/api/private/asks/') && method === 'PATCH') {
      const ask = list.find(ask => ask.id === path.split('/').at(-1))
      if (!ask) return Response.json({}, { status: 404 })
      ask.status = payload.status
      return Response.json({ ask })
    }
    throw Error('Unexpected fixture request: ' + method + ' ' + path)
  }
  const sessionStore = createMemorySessionStore()
  for (const member of members) await sessionStore.put(createHash('sha256').update(member.sid).digest('hex'), { ...member, accountLabel: member.displayName, expiresAt: Date.now() + 86_400_000 })
  const contactCards = createContactCards({ store: createMemoryContactCardStore() })
  const meetSwap = createMeetSwap({ store: createMemoryMeetStore() })
  const meetAsks = createMeetAsks({ createMessagingSession, fetchImpl })
  const notifications = createNotifications({ store: createMemoryNotificationStore() })
  const collectiveGroups = createCollectiveGroups({ store: createMemoryCollectiveGroupsStore(), active: async () => true })
  const group = await collectiveGroups.create(host, 'Climate Builders', null)
  const flyer = await collectiveGroups.createFlyer(host, group.id, { capacity: 30, approval: true })
  const ownerCard = await contactCards.save(host, { phone: '+14155550112', showPhone: true, email: 'sam@example.test', showEmail: true }, { name: host.displayName, headline: 'Climate partnerships' })
  const backend = { adapter: {}, readResource: async () => null, listImportIds: async () => [], listImportJobIds: async () => [], listAccountGrantIds: async () => [] }
  const handler = createPrivateBrowserHandler({
    baseUrl, sessionStore, dataMode: 'synthetic', login: { begin: async () => { throw Error('fixture only') }, finish: async () => { throw Error('fixture only') } },
    accountForProfile: async () => null, ownProfileId: async () => null,
    resolveOwner: async () => null, signup: async () => null, getBackend: async () => backend, issueAccountGrant: async () => ({}), revokeAccountGrant: async () => {},
    contactCards, notifications, collectiveGroups, meetSwap, meetAsks: asksEnabled ? meetAsks : undefined, meetEnabled: enabled,
    mcpEndpoint: baseUrl + '/mcp',
  })
  return { handler, host, other, meetSwap, meetAsks, contactCards, ownerCard, group, flyer, operations, asks, people, upstream, notifications }
}
