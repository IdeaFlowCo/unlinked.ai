import { z } from 'zod'
import { OverlayUnavailable } from './private-context.mjs'

// Private people notes & relations for the direct Unlinked key and OAuth
// connector (grant catalog v7, permission "Private people notes & relations").
// One semantic layer: every rule — names never merging (ambiguous_name),
// idempotent notes and links, createNew, provenance, relationType, relation
// edits, search, neighbourhood, delete, ensureRefs — belongs to the Noos
// people overlay (`/api/overlay`, noos docs/PEOPLE_OVERLAY.md). Unlinked only
// names people (refs) from data the owner can already read and states who is
// writing. The tools mirror the shared connector's `openchat__oc_*private*`
// shapes (docs/agent-api.md has the mapping).

export const PRIVATE_KINDS = Object.freeze(['person', 'company', 'idea', 'project'])
export const RELATION_TYPES = Object.freeze(['knows', 'family', 'works_at', 'worked_with', 'works_on', 'attended', 'interested_in', 'other'])

const PRIVATE = 'Owner-only private knowledge: visible only to the owner (never to the person it is about), stored in the owner’s Ideaflow people overlay and shown in Unlinked (person and contact pages) and OpenChat. Never notifies anyone. It is NOT a connection request and NOT messaging.'
const PROVENANCE = 'Notes and relations carry author (“owner” or “agent:<client>”), source (“app”, “connector”, “direct-key” or “suggestion”) and assertion (“stated” or “inferred”); null on records made before provenance was kept. Relations also carry relationType.'
const WRITTEN = 'Recorded as written by this agent (author agent:<key or app name>, source direct-key).'
const SUBJECT = 'subjectKind “unlinked” = an Unlinked person: a published profile id, a connection id from unlinked_list_connections (an imported LinkedIn contact) or a linkedin.com/in/ address (the same person is one entity whichever you give); “thing” = one of the owner’s saved people, companies, ideas or projects (its id); “user” = an OpenChat person (user id) the owner already has private notes about.'

const id = z.string().min(1).max(64)
const subjectKind = z.enum(['unlinked', 'thing', 'user'])
const subjectId = z.string().min(1).max(512)
const assertion = z.enum(['stated', 'inferred']).optional()

export const PRIVATE_NOTES_SCHEMAS = Object.freeze({
  unlinked_get_person_private: { profileId: z.string().min(1).max(512) },
  unlinked_get_private_thing: { thingId: id },
  unlinked_list_private_things: { query: z.string().max(120).optional(), kind: z.enum(PRIVATE_KINDS).optional() },
  unlinked_search_private: { query: z.string().max(120).optional(), relationType: z.enum(RELATION_TYPES).optional(), kind: z.enum(PRIVATE_KINDS).optional(), limit: z.number().int().min(1).max(50).optional() },
  unlinked_get_neighbourhood: { subjectKind, subjectId, depth: z.union([z.literal(1), z.literal(2)]).optional() },
  unlinked_save_private_thing: { kind: z.enum(PRIVATE_KINDS), name: z.string().min(1).max(120), createNew: z.boolean().optional(), clientRequestId: z.string().min(1).max(200).optional() },
  unlinked_add_private_note: { subjectKind, subjectId, text: z.string().min(1).max(4000), assertion },
  unlinked_delete_private_note: { noteId: id },
  unlinked_add_private_link: {
    subjectKind, subjectId, relation: z.string().min(1).max(60), toKind: z.enum(['unlinked', 'user', ...PRIVATE_KINDS]),
    toId: z.string().min(1).max(512).optional(), toName: z.string().min(1).max(120).optional(),
    createNew: z.boolean().optional(), clientRequestId: z.string().min(1).max(200).optional(), assertion,
  },
  unlinked_update_private_link: { linkId: id, relation: z.string().min(1).max(60), assertion },
  unlinked_delete_private_link: { linkId: id },
  unlinked_delete_private_thing: { thingId: id },
})

export const PRIVATE_NOTES_DESCRIPTIONS = Object.freeze({
  unlinked_get_person_private: `Read the owner’s private card about an Unlinked person: profileId may be a published profile id, a connection id from unlinked_list_connections (an imported LinkedIn contact) or a linkedin.com/in/ address. Returns the notes and relations recorded about that person (with note and link ids for corrections), plus profileId, connectionId and linkedinRefHash when they apply. entities is empty when nothing is recorded yet. ${PROVENANCE} ${PRIVATE}`,
  unlinked_get_private_thing: `Read one of the owner’s private entities (a saved person, company, idea or project, or any entity id from another private tool) with its notes and relations. ${PROVENANCE} ${PRIVATE}`,
  unlinked_list_private_things: `List the owner’s private entities (saved people, companies, ideas and projects, and Unlinked or OpenChat people they wrote about), optionally by name and kind. Use an id with unlinked_get_private_thing. ${PRIVATE}`,
  unlinked_search_private: `Search the owner’s private people knowledge in one call: entities matched by name or private note text, and relations matched by relation text, either end’s name, or relationType (${RELATION_TYPES.join(', ')}). Give at least one of query, relationType or kind. At most 50 of each; truncated says more matched. ${PROVENANCE} ${PRIVATE}`,
  unlinked_get_neighbourhood: `Read one person or thing and what surrounds it in the owner’s private graph: everything one (default) or two private relations away, and those relations (fromId/toId). ${SUBJECT} Never creates anything; empty when nothing is recorded. Bounded; truncated says it was cut. ${PROVENANCE} ${PRIVATE}`,
  unlinked_save_private_thing: `Find or save a private person, company, idea or project by name, for someone with no Unlinked profile or imported contact (“remember Maya from dinner”). Returns its id for notes and links. A name is reused only when it names exactly one saved thing; when several share it the call fails with code ambiguous_name and candidates — ask the user which one. Set createNew true with a clientRequestId only to save a different one with an existing name; retries return the same entity. ${PRIVATE}`,
  unlinked_add_private_note: `Add a private note about a person or thing. ${SUBJECT} Adding the same text again returns the existing note. ${WRITTEN} Set assertion “inferred” when you concluded it yourself. ${PRIVATE}`,
  unlinked_delete_private_note: `Delete (undo) one of the owner’s private notes by note id. ${PRIVATE}`,
  unlinked_add_private_link: `Record a private relation in the owner’s own words (“knows”, “sister of”, “worked with”, “works at”), for example that one imported contact knows another. Subject: ${SUBJECT} Target: toKind “unlinked” + toId (published profile id, connection id or linkedin.com/in/ address), toKind “user” + toId (OpenChat user id already in the owner’s private notes), or toKind person/company/idea/project with toId (saved thing id) or toName. A name is reused only when it names exactly one saved thing; when several share it the call fails with code ambiguous_name and candidates — ask the user which one, then pass its id. Set createNew true with a clientRequestId only to save a different one with an existing name. The same subject, relation and target is one link, so retries never duplicate. ${WRITTEN} relationType is derived from the words. ${PRIVATE}`,
  unlinked_update_private_link: `Correct one of the owner’s private relations in place by link id, for example “sister of” to “cousin of”. The relation text, its relationType and the link’s identity change together; if the owner already has that exact relation between the same two ends, the two become one and the existing link is returned with merged true. ${WRITTEN} ${PRIVATE}`,
  unlinked_delete_private_link: `Delete (undo) one of the owner’s private relations by link id. ${PRIVATE}`,
  unlinked_delete_private_thing: `Delete (undo) one of the owner’s private entities by id: removes it with its private notes and every private relation to or from it. Cannot be reversed. Deleting an entity about an Unlinked person forgets only the owner’s private notes; the profile and contact are untouched. ${PRIVATE}`,
})

export const PRIVATE_NOTES_MUTATING = new Set(['unlinked_save_private_thing', 'unlinked_add_private_note', 'unlinked_delete_private_note', 'unlinked_add_private_link', 'unlinked_update_private_link', 'unlinked_delete_private_link', 'unlinked_delete_private_thing'])
export const PRIVATE_NOTES_DESTRUCTIVE = new Set(['unlinked_delete_private_note', 'unlinked_delete_private_link', 'unlinked_delete_private_thing'])

const ENTITY_ID = /^[A-Za-z0-9_-]{1,80}$/
const HASH = /^[a-f0-9]{64}$/
const PERSON_REF = /^unlinked:person:(.{1,160})$/
const LINKEDIN_REF = /^linkedin:in:([a-f0-9]{64})$/
const OPENCHAT_USER_REF = /^openchat:user:(.{1,200})$/
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max)

// `createError(code, message, details)` builds the typed AccountToolError;
// `lookupContact(grant, input, signal)` is the owner-scoped
// unlinked_lookup_contact (throws typed not_found / invalid_input);
// `identityFor(owner)` is the Ideaflow identity bridge of unlinked-9kk.4.
export function createPrivateNotesTools({ overlay, identityFor, lookupContact, createError }) {
  const fail = (code, message, details) => createError(code, message, details)
  const configured = Boolean(overlay && typeof overlay.request === 'function' && typeof identityFor === 'function')
  const who = async grant => {
    if (!configured) throw fail('upstream_unavailable', 'Private people notes are not configured on this runtime.')
    let value
    try { value = await identityFor({ ownerId: grant.ownerId, userId: grant.userId }) } catch { throw fail('upstream_unavailable', 'The owner’s Ideaflow identity could not be read right now; retry.') }
    if (!value || typeof value.issuer !== 'string' || typeof value.subject !== 'string') throw fail('identity_unavailable', 'This Unlinked account has no Ideaflow sign-in identity, so it has no private people notes yet. Sign in to Unlinked with Ideaflow once.')
    return value
  }
  // Noos answers: 2xx body; 404 not_found; 409 ambiguous_name with the
  // owner's own candidates; other 4xx are the overlay's own input codes.
  const overlayCall = async (identity, method, path, body) => {
    let answer
    try { answer = await overlay.request(identity, method, path, body) }
    catch (error) { throw error instanceof OverlayUnavailable ? fail('upstream_unavailable', 'The private people overlay is unavailable right now; retry.') : error }
    if (answer.status < 300) return answer.body
    const code = typeof answer.body?.error === 'string' ? answer.body.error.slice(0, 64) : 'invalid_body'
    if (answer.status === 404) throw fail('not_found', 'Nothing of the owner’s has that id.')
    if (answer.status === 409 && code === 'ambiguous_name') throw fail('ambiguous_name', 'Several of the owner’s saved things have that name. Ask the user which one, then pass its id; or set createNew with a clientRequestId to save a separate one.',
      { candidates: (Array.isArray(answer.body.candidates) ? answer.body.candidates : []).slice(0, 20).map(value => ({ id: value.id, kind: value.kind, name: value.name })) })
    throw fail('invalid_input', `The private overlay refused the input (${code}).`, { overlayCode: code })
  }
  const provenance = (grant, value) => ({ author: `agent:${clean(grant.agent, 80) || 'API key'}`, source: 'direct-key', assertion: value ?? 'stated' })

  // An Unlinked person, named only from data the owner can already read: a
  // published profile, or the owner's own import (validated against it).
  const person = async (grant, value, signal) => {
    const tries = /linkedin\.com\/in\//i.test(value) ? [{ linkedinUrl: value }]
      : [...(value.length <= 128 ? [{ connectionId: value }] : []), ...(value.length <= 160 ? [{ profileId: value }] : [])]
    let unavailable = null
    for (const input of tries) {
      let found
      try { found = await lookupContact(grant, input, signal) }
      catch (error) {
        if (['not_found', 'invalid_input'].includes(error?.code)) continue
        // One lookup path down (e.g. the People index): try the others first.
        if (error?.code === 'upstream_unavailable') { unavailable = error; continue }
        throw error
      }
      const contact = found?.contact
      if (!contact) continue
      const owned = found.visibility === 'owner_private'
      const refs = [...(owned && HASH.test(contact.linkedinRefHash ?? '') ? [`linkedin:in:${contact.linkedinRefHash}`] : []),
        ...(contact.publishedProfileId ? [`unlinked:person:${contact.publishedProfileId}`] : [])]
      if (refs.length) return { refs, name: clean(contact.name, 120) || 'Unnamed', person: { name: contact.name ?? null, profileId: contact.publishedProfileId ?? null, connectionId: owned ? contact.connectionId ?? null : null, linkedinRefHash: owned ? contact.linkedinRefHash ?? null : null } }
    }
    if (unavailable) throw unavailable
    throw fail('not_found', 'No published Unlinked profile or contact of the owner matches that id or LinkedIn address.')
  }
  const existingByRef = async (identity, ref) => {
    const answer = await overlay.request(identity, 'POST', 'lookup', { ref }).catch(error => { throw error instanceof OverlayUnavailable ? fail('upstream_unavailable', 'The private people overlay is unavailable right now; retry.') : error })
    if (answer.status === 404) return null
    if (answer.status >= 300) throw fail('invalid_input', 'The private overlay refused the reference.')
    return answer.body?.entity ?? null
  }
  // The entity a subject names. Writes create the entity for an Unlinked
  // person (ensureRefs joins profile and import refs); reads never create.
  const subject = async (grant, identity, kind, value, { create }, signal) => {
    if (kind === 'thing') {
      if (!ENTITY_ID.test(value)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      return { id: value }
    }
    if (kind === 'user') {
      const found = await existingByRef(identity, `openchat:user:${value}`)
      if (!found) throw fail('not_found', 'The owner has no private notes about that OpenChat person yet. Record OpenChat people through the shared Ideaflow connector (openchat__ tools) first; this key can then link to them.')
      return { id: found.id }
    }
    const named = await person(grant, value, signal)
    if (!create) {
      const found = []
      for (const ref of named.refs) { const entity = await existingByRef(identity, ref); if (entity && !found.some(value => value.id === entity.id)) found.push(entity) }
      return { ...named, entities: found }
    }
    const made = await overlayCall(identity, 'POST', 'entities', { kind: 'person', name: named.name, refs: named.refs })
    return { ...named, id: made.entity.id }
  }

  // Replace overlay refs with what the owner's agent can use: profileId,
  // linkedinRefHash (+ connectionId when the owner imported them), openchatUserId.
  const annotate = async (grant, value, signal) => {
    const hashes = new Set()
    const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { if (Array.isArray(node.refs)) for (const ref of node.refs) { const hash = LINKEDIN_REF.exec(ref)?.[1]; if (hash) hashes.add(hash) } Object.values(node).forEach(visit) } }
    visit(value)
    const connections = new Map()
    if (hashes.size) {
      try {
        const found = await lookupContact(grant, { refHashes: [...hashes].slice(0, 100) }, signal)
        for (const contact of found?.contacts ?? []) connections.set(contact.linkedinRefHash, contact.connectionId)
      } catch { /* annotation is best-effort */ }
    }
    const rewrite = node => {
      if (Array.isArray(node)) return node.map(rewrite)
      if (!node || typeof node !== 'object') return node
      const out = {}
      for (const [key, child] of Object.entries(node)) if (key !== 'refs' && key !== 'ownerKey') out[key] = rewrite(child)
      if (Array.isArray(node.refs)) {
        const profileId = node.refs.map(ref => PERSON_REF.exec(ref)?.[1]).find(Boolean)
        const hash = node.refs.map(ref => LINKEDIN_REF.exec(ref)?.[1]).find(Boolean)
        const user = node.refs.map(ref => OPENCHAT_USER_REF.exec(ref)?.[1]).find(Boolean)
        if (profileId) out.profileId = profileId
        if (hash) { out.linkedinRefHash = hash; out.connectionId = connections.get(hash) ?? null }
        if (user) out.openchatUserId = user
      }
      return out
    }
    return rewrite(value)
  }
  const query = (path, params) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    const text = search.toString()
    return text ? `${path}?${text}` : path
  }
  const out = (kind, body) => ({ kind, ...body, visibility: 'owner_private' })

  return {
    async unlinked_get_person_private(grant, { profileId }, signal) {
      const identity = await who(grant)
      const found = await subject(grant, identity, 'unlinked', profileId, { create: false }, signal)
      const entities = []
      for (const entity of found.entities) entities.push((await overlayCall(identity, 'GET', `entities/${encodeURIComponent(entity.id)}`)).entity)
      return out('unlinked_person_private', { person: found.person, entities: await annotate(grant, entities, signal) })
    },
    async unlinked_get_private_thing(grant, { thingId }, signal) {
      const identity = await who(grant)
      if (!ENTITY_ID.test(thingId)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      return out('unlinked_private_thing', { entity: await annotate(grant, (await overlayCall(identity, 'GET', `entities/${encodeURIComponent(thingId)}`)).entity, signal) })
    },
    async unlinked_list_private_things(grant, { query: q, kind }, signal) {
      const identity = await who(grant)
      const listed = await overlayCall(identity, 'GET', query('entities', { q, kind }))
      return out('unlinked_private_things', { entities: await annotate(grant, listed.entities ?? [], signal) })
    },
    async unlinked_search_private(grant, { query: q, relationType, kind, limit }, signal) {
      if (!q?.trim() && !relationType && !kind) throw fail('invalid_input', 'Give at least one of query, relationType or kind.')
      const identity = await who(grant)
      const found = await overlayCall(identity, 'GET', query('search', { q, relationType, kind, limit }))
      return out('unlinked_search_private', await annotate(grant, { entities: found.entities ?? [], links: found.links ?? [], truncated: found.truncated === true }, signal))
    },
    async unlinked_get_neighbourhood(grant, { subjectKind: kind, subjectId: value, depth = 1 }, signal) {
      const identity = await who(grant)
      let ids
      if (kind === 'unlinked') ids = (await subject(grant, identity, kind, value, { create: false }, signal)).entities.map(entity => entity.id)
      else {
        try { ids = [(await subject(grant, identity, kind, value, { create: false }, signal)).id] }
        catch (error) { if (error?.code === 'not_found' && kind === 'user') ids = []; else throw error }
      }
      if (!ids.length) return out('unlinked_neighbourhood', { depth, center: null, entities: [], links: [], truncated: false })
      const hoods = []
      for (const entityId of ids) hoods.push(await overlayCall(identity, 'GET', `entities/${encodeURIComponent(entityId)}/neighbourhood?depth=${depth}`))
      const [first] = hoods
      // The same person named by profile and by import can be two entities until joined; merge their surroundings.
      const entities = new Map(), links = new Map()
      for (const hood of hoods) { for (const entity of [...(hood === first ? [] : [hood.center]), ...(hood.entities ?? [])]) entities.set(entity.id, entity); for (const link of hood.links ?? []) links.set(link.id, link) }
      entities.delete(first.center.id)
      return out('unlinked_neighbourhood', await annotate(grant, { depth: first.depth, center: first.center, entities: [...entities.values()], links: [...links.values()], truncated: hoods.some(hood => hood.truncated === true) }, signal))
    },
    async unlinked_save_private_thing(grant, { kind, name, createNew, clientRequestId }, signal) {
      if (createNew && !clientRequestId) throw fail('invalid_input', 'createNew needs a clientRequestId so a retry returns the same entity.')
      const identity = await who(grant)
      const saved = await overlayCall(identity, 'POST', 'entities', { kind, name, ...(createNew !== undefined ? { createNew } : {}), ...(clientRequestId !== undefined ? { clientRequestId } : {}) })
      return out('unlinked_private_thing_saved', { created: saved.created === true, entity: await annotate(grant, saved.entity, signal) })
    },
    async unlinked_add_private_note(grant, { subjectKind: kind, subjectId: value, text, assertion: stated }, signal) {
      const identity = await who(grant)
      const target = await subject(grant, identity, kind, value, { create: true }, signal)
      const added = await overlayCall(identity, 'POST', `entities/${encodeURIComponent(target.id)}/notes`, { text, provenance: provenance(grant, stated) })
      return out('unlinked_private_note_added', { created: added.created === true, entityId: target.id, ...(target.person ? { person: target.person } : {}), note: added.note })
    },
    async unlinked_delete_private_note(grant, { noteId }) {
      const identity = await who(grant)
      if (!ENTITY_ID.test(noteId)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      await overlayCall(identity, 'DELETE', `notes/${encodeURIComponent(noteId)}`)
      return out('unlinked_private_note_deleted', { noteId, deleted: true })
    },
    async unlinked_add_private_link(grant, input, signal) {
      const { subjectKind: kind, subjectId: value, relation, toKind, toId, toName, createNew, clientRequestId, assertion: stated } = input
      const named = ['unlinked', 'user'].includes(toKind)
      if (named ? toId === undefined || toName !== undefined || createNew !== undefined || clientRequestId !== undefined : (toId === undefined) === (toName === undefined))
        throw fail('invalid_input', named ? `toKind ${toKind} needs toId (and no toName or createNew).` : 'Give exactly one of toId (a saved thing id) or toName.')
      if ((createNew || clientRequestId !== undefined) && toName === undefined) throw fail('invalid_input', 'createNew and clientRequestId apply only with toName.')
      if (createNew && !clientRequestId) throw fail('invalid_input', 'createNew needs a clientRequestId so a retry returns the same entity.')
      const identity = await who(grant)
      const from = await subject(grant, identity, kind, value, { create: true }, signal)
      let to
      if (named) to = await subject(grant, identity, toKind, toId, { create: true }, signal)
      else if (toId !== undefined) { if (!ENTITY_ID.test(toId)) throw fail('not_found', 'Nothing of the owner’s has that id.'); to = { id: toId } }
      else to = { id: (await overlayCall(identity, 'POST', 'entities', { kind: toKind, name: toName, ...(createNew !== undefined ? { createNew } : {}), ...(clientRequestId !== undefined ? { clientRequestId } : {}) })).entity.id }
      const added = await overlayCall(identity, 'POST', `entities/${encodeURIComponent(from.id)}/links`, { relation, toId: to.id, provenance: provenance(grant, stated) })
      return out('unlinked_private_link_added', { created: added.created === true, fromId: from.id, toId: to.id,
        ...(from.person ? { from: from.person } : {}), ...(to.person ? { to: to.person } : {}), link: await annotate(grant, added.link, signal) })
    },
    async unlinked_update_private_link(grant, { linkId, relation, assertion: stated }, signal) {
      const identity = await who(grant)
      if (!ENTITY_ID.test(linkId)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      const updated = await overlayCall(identity, 'PATCH', `links/${encodeURIComponent(linkId)}`, { relation, provenance: provenance(grant, stated) })
      return out('unlinked_private_link_updated', { merged: updated.merged === true, link: await annotate(grant, updated.link, signal) })
    },
    async unlinked_delete_private_link(grant, { linkId }) {
      const identity = await who(grant)
      if (!ENTITY_ID.test(linkId)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      await overlayCall(identity, 'DELETE', `links/${encodeURIComponent(linkId)}`)
      return out('unlinked_private_link_deleted', { linkId, deleted: true })
    },
    async unlinked_delete_private_thing(grant, { thingId }) {
      const identity = await who(grant)
      if (!ENTITY_ID.test(thingId)) throw fail('not_found', 'Nothing of the owner’s has that id.')
      const removed = await overlayCall(identity, 'DELETE', `entities/${encodeURIComponent(thingId)}`)
      return out('unlinked_private_thing_deleted', { thingId, deleted: true, notesRemoved: removed.notesRemoved ?? 0, linksRemoved: removed.linksRemoved ?? 0, refsRemoved: removed.refsRemoved ?? 0 })
    },
  }
}
