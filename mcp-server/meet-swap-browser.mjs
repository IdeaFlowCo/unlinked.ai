import { randomUUID } from 'node:crypto'
import { CONTACT_CARD_TOKEN, renderContactVcard, vcardContentDisposition } from './contact-card.mjs'
import { visitorKey } from './client-address.mjs'
import { flyerInvitePath, GROUP_UUID } from './collective-groups.mjs'
import { CONTACT_CHANNELS, MEET_EVENT, MEET_ID, MeetError, oneLine, parseSwap, socialHandle } from './meet-swap.mjs'
import { parseAskDraft, sameName } from './meet-asks.mjs'
import { meetAgent, renderMeetLinks, renderNetworkAsks, renderPersonAskMount, renderPersonAskPage, renderPersonAsks, renderSwap, renderSwapPerson, renderSwapSuccess, renderSwaps } from './meet-swap-views.mjs'
import { renderNotFound, renderSignInRequired } from './private-onboarding-views.mjs'

export const isPublicMeetPath = path => path.startsWith('/m/')
export const isPrivateMeetPath = path => path === '/swaps' || path.startsWith('/swaps/') || path === '/network/asks' || path.startsWith('/network/asks/')
const GROUP = new RegExp('^' + GROUP_UUID + '$')
const notice = { created: 'QR link created.', disabled: 'QR link turned off.', note: 'Note saved.', ask: 'Private ask saved.', status: 'Ask updated.' }
const statusText = value => Object.hasOwn(notice, value) ? notice[value] : ''
const keyFor = session => JSON.stringify([session.owner.ownerId, session.owner.userId, session.csrf])
const idPath = (type, id) => '/swaps/' + type + '/' + id
const backPath = value => value === '/network/asks' || /^\/(?:swaps\/person\/[0-9a-f-]{36}|people\/[A-Za-z0-9._~%-]{1,480}|network\/contacts\/[A-Za-z0-9._~%-]{1,480})$/.test(value) ? value : '/network/asks'

function fields(input, allowed) {
  if ([...input.keys()].some(key => !allowed.includes(key) || input.getAll(key).length !== 1)) {
    throw new MeetError(400, 'Open the form again and try once more.')
  }
  return input
}

function budget(now) {
  let slots = new Map(), end = 0
  return (key, max) => {
    const tick = now()
    if (tick >= end) { slots = new Map(); end = tick + 60_000 }
    if (key === null || (!slots.has(key) && slots.size >= 10_000)) return false
    const count = slots.get(key) ?? 0
    if (count >= max) return false
    slots.set(key, count + 1)
    return true
  }
}

export function createMeetBrowser({ meet, asks, cards, openCard, origin, groups, notifications, ownProfileId, photoFor, body, acquireOwner, now = Date.now }) {
  const readBudget = budget(now), writeBudget = budget(now), qrBudget = budget(now), ownerBudget = budget(now)
  const contexts = new Map(), drafts = new Map(), syncing = new Map()
  const expire = (records, max) => {
    for (const [key, record] of records) if (record.until <= now()) records.delete(key)
    if (records.size >= max) records.delete(records.keys().next().value)
  }
  const remember = (store, session, value, minutes, max) => {
    expire(store, max)
    const id = randomUUID()
    store.set(id, { ...value, key: keyFor(session), until: now() + minutes * 60_000 })
    return id
  }
  const recall = (store, session, id) => {
    const record = store.get(id)
    return record?.until > now() && record.key === keyFor(session) ? record : null
  }
  const getBody = async (request, allowed, session) => {
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') throw new MeetError(415, 'Use the Unlinked form to continue.')
    const input = fields(new URLSearchParams((await body(request, 8192)).toString('utf8')), allowed)
    if (session && input.get('csrf') !== session.csrf) throw new MeetError(403, 'Refresh the page before saving.')
    return input
  }
  const getOwnerCard = async owner => {
    const stored = await cards.read(owner)
    if (!stored?.card?.phone) return null
    return { ...stored, card: await openCard(stored.token) }
  }
  const groupFor = async (owner, id) => {
    if (!groups || !GROUP.test(id ?? '')) return null
    const detail = await groups.detail(owner, id).catch(() => null)
    return detail?.organizer && detail.flyer?.active
      ? { id, name: detail.name, href: flyerInvitePath(id, detail.flyer.id) } : null
  }
  const availableGroups = async owner => {
    const directory = await groups?.directory(owner).catch(() => null)
    return (await Promise.all((directory?.groups ?? []).filter(group => group.organizer).slice(0, 16).map(group => groupFor(owner, group.id)))).filter(Boolean)
  }
  const syncEncounter = async (session, contact, encounter) => {
    if (!asks || !contact || !encounter?.ask || encounter.askId) return
    const key = session.owner.ownerId + ':' + encounter.id
    if (syncing.has(key)) return syncing.get(key)
    if (syncing.size >= 8) throw new MeetError(429, 'OpenChat is busy. Try saving the ask again shortly.')
    const release = acquireOwner(session.owner)
    if (!release) throw new MeetError(409, 'This account is changing. Try again shortly.')
    const job = (async () => {
      const result = await asks.saveForContact(session, contact, encounter.ask, 'QR swap', encounter.at)
      await meet.recordAsk(session.owner, contact.id, encounter.id, result.authorId, result.ask.id)
    })().finally(() => { syncing.delete(key); release() })
    syncing.set(key, job)
    return job
  }
  const safeError = error => error instanceof MeetError ? error : new MeetError(error?.message === 'private_body_limit' ? 413 : 503, 'This page could not finish. Try again shortly.')

  async function publicRoute({ request, url, response, render }) {
    const token = url.pathname.slice('/m/'.length), method = request.method
    const notFound = () => render(renderNotFound(), 404)
    if (!CONTACT_CARD_TOKEN.test(token)) return notFound()
    const ip = visitorKey(request)
    if (!(method === 'POST' ? writeBudget(ip, 12) : readBudget(ip, 60))) {
      response.writeHead(429, { 'Retry-After': '60' }).end('Try again in a minute.')
      return
    }
    let link, card, input, release
    try {
      const query = fields(url.searchParams, ['e', 'g', 'vcard'])
      const event = query.get('e'), group = query.get('g')
      if ((query.has('vcard') && (method !== 'GET' || query.get('vcard') !== '1')) || !event || event.length > 45 || !MEET_EVENT.test(event) || (group && !GROUP.test(group))) return notFound()
      const owner = await cards.ownerForToken(token)
      if (!owner) return notFound()
      const [storedLink, sharedCard] = await Promise.all([meet.link(owner, token, event), openCard(token)])
      link = storedLink
      card = sharedCard
      if (!link || !card?.name || !card.phone || (group && link.group?.id !== group)) return notFound()
      if (query.has('vcard')) {
        const social = [link.instagram && 'https://www.instagram.com/' + link.instagram + '/', link.x && 'https://x.com/' + link.x].filter(Boolean)
        response.writeHead(200, { 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': vcardContentDisposition(card) })
        response.end(renderContactVcard(card, origin, { social }))
        return
      }
      const liveGroup = group ? await groupFor(owner, group) : null
      // A rotated flyer belongs to a new invitation. Earlier QR codes continue
      // the swap without forwarding to it.
      link = { ...link, group: liveGroup?.href === link.group?.href ? liveGroup : null }
      const profileId = await ownProfileId?.(owner).catch(() => null)
      const photo = profileId && photoFor ? await Promise.resolve().then(() => photoFor(profileId)).catch(() => null) : null
      if (photo) card = { ...card, photo }
      if (method !== 'POST') return render(renderSwap({ link, card, submission: randomUUID() }), 200)
      if (!qrBudget(owner.ownerId + ':' + event, 40)) {
        response.writeHead(429, { 'Retry-After': '60' }).end('This QR is busy. Try again in a minute.')
        return
      }
      input = await getBody(request, ['submission', ...CONTACT_CHANNELS, 'name', 'about', 'ask', 'invite', 'join'])
      const values = parseSwap(input, link)
      release = acquireOwner(owner)
      if (!release || !await openCard(token)) return notFound()
      const { contact, encounter, duplicate } = await meet.capture(owner, link, values)
      if (encounter) {
        // This is an in-app notification. The kind is never eligible for email.
        await notifications?.notify({ recipient: owner, kind: 'meet_swap', actorName: encounter.name || contact?.name || 'Someone you met',
          subjectId: encounter.id, dedupeKey: 'meet-swap:' + owner.ownerId + ':' + encounter.id }).catch(() => {})
        // Keep the swap fast. It is already durable, including the pending ask.
        if (!duplicate) void syncEncounter({ owner, displayName: card.name }, contact, encounter).catch(() => {})
      }
      return render(renderSwapSuccess({ link, card, joined: Boolean(encounter?.group) }), 200)
    } catch (error) {
      const { status, message } = safeError(error)
      if (status === 404) return notFound()
      if (!link || !card) { response.writeHead(status).end(message); return }
      return render(renderSwap({ link, card, submission: MEET_ID.test(input?.get('submission') ?? '') ? input.get('submission') : randomUUID(), values: input, error: message }), status)
    } finally { release?.() }
  }

  const contactContext = contact => ({ kind: 'swap', id: contact.id, name: contact.name || 'Unnamed contact' })
  const listForContact = async (session, contact) => contact.authorId ? asks?.forOwner(session, { kind: 'thing', id: contact.authorId }).catch(() => null) : { asks: [] }
  const listPage = async (session, chrome, extra = {}) => renderNetworkAsks(chrome, {
    data: await meet.read(session.owner), result: await asks?.forOwner(session).catch(() => null), ...extra,
  })
  const saveContactAsk = async (session, person, text, source) => {
    const { contacts } = await meet.read(session.owner)
    const contact = contacts.find(row => row.id === person.id)
    if (!contact) throw new MeetError(404, 'This contact is no longer available.')
    const saved = await asks.saveForContact(session, contact, text, source)
    await meet.recordAsk(session.owner, contact.id, null, saved.authorId, saved.ask.id)
  }
  const notificationPath = async (owner, encounterId) => {
    const { encounters } = await meet.read(owner)
    const encounter = encounters.find(row => row.id === encounterId)
    return !encounter ? '/swaps' : encounter.contactId ? idPath('person', encounter.contactId) : idPath('encounter', encounter.id)
  }

  async function privateRoute({ request, url, response, session, crossed, chrome, render, redirect }) {
    const { pathname: path, searchParams: query } = url
    if (crossed) return render(renderNotFound(), 404)
    if (!session) return request.method === 'GET' ? render(renderSignInRequired({ next: path }), 401) : render(renderNotFound(), 401)
    const { owner } = session
    const post = request.method === 'POST'
    if (post && !ownerBudget(owner.ownerId, 45)) return render(renderNetworkAsks(chrome, { error: 'Try again in a minute.' }), 429)
    let draft, candidates, proof, captureText, captureContext
    try {
      if (path === '/swaps/links') {
        const own = await getOwnerCard(owner)
        if (!post) {
          const data = await meet.read(owner)
          return render(renderMeetLinks(chrome, { links: own?.card?.phone ? data.links.filter(link => link.token === own.token && link.active) : [],
            groups: own?.card?.phone ? await availableGroups(owner) : [], ownerCard: own?.card, origin, notice: statusText(query.get('done')) }), 200)
        }
        const input = await getBody(request, ['csrf', 'action', 'event', 'label', 'instagram', 'x', 'group'], session)
        if (input.get('action') === 'disable' && MEET_EVENT.test(input.get('event') ?? '')) {
          await meet.disableLink(owner, input.get('event'))
          return redirect('/swaps/links?done=disabled')
        }
        if (input.get('action') !== 'create' || !own?.card?.phone) throw new MeetError(400, 'Set a shared phone number on your contact card first.')
        const label = oneLine(input.get('label'), 80)
        if (!label) throw new MeetError(400, 'Give the event a name.')
        const group = input.get('group') ? await groupFor(owner, input.get('group')) : null
        if (input.get('group') && !group) throw new MeetError(400, 'Choose a group with an active invitation you organize.')
        await meet.createLink(owner, own.token, { label, instagram: socialHandle('instagram', input.get('instagram')), x: socialHandle('x', input.get('x')), group })
        return redirect('/swaps/links?done=created')
      }
      if (!post && (path === '/swaps' || path === '/swaps/invites')) {
        const data = await meet.read(owner)
        const eventOptions = [...new Map(data.encounters.map(row => [row.event, row.eventLabel]))]
        return render(renderSwaps(chrome, { data, invited: path.endsWith('/invites'), eventOptions,
          filter: { event: query.get('e'), query: oneLine(query.get('q'), 100) } }), 200)
      }
      const detail = /^\/swaps\/(person|encounter)\/([0-9a-f-]{36})$/.exec(path)
      if (detail) {
        const data = await meet.read(owner)
        const [, type, id] = detail
        const contact = type === 'person' ? data.contacts.find(row => row.id === id) : null
        const encounters = data.encounters.filter(row => contact ? row.contactId === contact.id : type === 'encounter' && row.id === id && !row.contactId)
        if (!encounters.length) return render(renderNotFound(chrome), 404)
        if (post) {
          if (!contact) return render(renderNotFound(chrome), 404)
          const input = await getBody(request, ['csrf', 'action', 'note', 'encounter'], session)
          const view = async error => render(renderSwapPerson(chrome, { contact, encounters, askResult: await listForContact(session, contact), error: error.message, ua: request.headers['user-agent'] }), error.status)
          try {
            if (input.get('action') === 'note') {
              await meet.note(owner, id, oneLine(input.get('note'), 240))
              return redirect(path + '?done=note')
            }
            if (input.get('action') !== 'retry') return render(renderNotFound(chrome), 404)
            const encounter = encounters.find(row => row.id === input.get('encounter'))
            if (!encounter?.ask) return render(renderNotFound(chrome), 404)
            await syncEncounter(session, contact, encounter)
            return redirect(path + '?done=ask')
          } catch (error) { return view(safeError(error)) }
        }
        return render(renderSwapPerson(chrome, { contact, encounters, askResult: contact && await listForContact(session, contact),
          notice: statusText(query.get('done')), ua: request.headers['user-agent'] }), 200, contact ? contactContext(contact) : null)
      }
      if (!asks) return render(renderNotFound(chrome), 404)
      if (!post && path === '/network/asks/person') {
        if (!ownerBudget(owner.ownerId, 45)) throw new MeetError(429, 'Try again in a minute.')
        const entry = recall(contexts, session, query.get('context'))
        if (!entry?.back) return render(renderNotFound(chrome), 404)
        const result = await asks.forOwner(session, entry.context).catch(() => null)
        const section = renderPersonAsks({ result, csrf: session.csrf, back: entry.back })
        if (request.headers.accept === 'text/html; fragment=asks') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(section)
          return
        }
        return render(renderPersonAskPage(chrome, entry.context, entry.back, section), 200, entry.context)
      }
      if (!post && path === '/network/asks') {
        if (!ownerBudget(owner.ownerId, 45)) throw new MeetError(429, 'Try again in a minute.')
        return render(await listPage(session, chrome, { notice: statusText(query.get('done')) }), 200)
      }
      if (post && path === '/network/asks/preview') {
        const input = await getBody(request, ['csrf', 'text', 'source', 'context'], session)
        const context = recall(contexts, session, input.get('context'))?.context
        if (input.has('context') && !context) throw new MeetError(409, 'Reopen the person’s page to capture an ask for them.')
        captureText = input.get('text')?.slice(0, 240) ?? ''
        captureContext = context
        draft = parseAskDraft(captureText, context)
        if (draft.useContext) candidates = [context]
        else {
          const [{ contacts }, privatePeople] = await Promise.all([meet.read(owner), asks.findPeople(session, draft.name)])
          const matches = contacts.filter(person => person.name && sameName(person.name, draft.name))
          const ids = new Set(matches.map(person => person.authorId).filter(Boolean))
          candidates = [...matches.map(person => ({ ...contactContext(person), detail: 'QR contact' })), ...privatePeople.filter(person => !ids.has(person.id))]
        }
        if (!candidates.length) throw new MeetError(404, 'No matching person in your saved contacts. Open their Unlinked profile to capture an ask for them.')
        if (candidates.length > 16) throw new MeetError(400, 'More than 16 people match. Use a full name or open the person’s page.')
        const source = input.get('source') === 'Dictated' ? 'Dictated' : 'Typed'
        proof = remember(drafts, session, { draft, candidates, source, busy: false }, 10, 1000)
        return render(renderNetworkAsks(chrome, { draft, candidates, proof }), 200)
      }
      if (post && path === '/network/asks/save') {
        const input = await getBody(request, ['csrf', 'proof', 'person'], session)
        const pending = recall(drafts, session, input.get('proof'))
        const selection = input.get('person')
        if (!pending || !/^\d{1,2}$/.test(selection ?? '') || !pending.candidates[Number(selection)] || pending.busy) {
          throw new MeetError(409, 'Review the draft again before saving.')
        }
        draft = pending.draft
        candidates = pending.candidates
        proof = input.get('proof')
        const person = candidates[Number(selection)]
        pending.busy = true
        try {
          if (person.kind === 'swap') await saveContactAsk(session, person, draft.text, pending.source)
          else await asks.save(session, person, draft.text, pending.source)
          drafts.delete(proof)
        } finally { pending.busy = false }
        return redirect('/network/asks?done=ask')
      }
      if (post && path === '/network/asks/status') {
        const input = await getBody(request, ['csrf', 'ask', 'status', 'back'], session)
        await asks.update(session, input.get('ask'), input.get('status'))
        const back = backPath(input.get('back'))
        return redirect(back === '/network/asks' ? back + '?done=status' : back)
      }
      return render(renderNotFound(chrome), 404)
    } catch (error) {
      const { status, message } = safeError(error)
      if (path === '/swaps/links') {
        const [own, data] = await Promise.all([getOwnerCard(owner).catch(() => null), meet.read(owner).catch(() => null)])
        return render(renderMeetLinks(chrome, { links: data?.links.filter(link => own?.card?.phone && link.token === own.token && link.active) ?? [],
          groups: await availableGroups(owner), ownerCard: own?.card, origin, error: message }), status)
      }
      const view = renderNetworkAsks(chrome, { error: message, draft, candidates: proof ? candidates : null, proof })
      return render({ ...view, meetDraft: captureText }, status, captureContext)
    }
  }

  return {
    publicRoute, privateRoute, notificationPath,
    agent(session, context, value) {
      if (!asks) return ''
      const contextToken = context ? remember(contexts, session, { context }, 60, 5000) : null
      return meetAgent({ csrf: session.csrf, context, contextToken, value })
    },
    personSection(session, context, back) {
      const contextToken = remember(contexts, session, { context, back: backPath(back) }, 60, 5000)
      return renderPersonAskMount(contextToken)
    },
  }
}
