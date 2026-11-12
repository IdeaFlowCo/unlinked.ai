import { SignJWT } from 'jose'
import { profilePath } from '../src/utils/public-people/profile-handles.mjs'

// Read-only view of the Ideaflow people overlay (Noos `/api/overlay`, docs in
// noos docs/PEOPLE_OVERLAY.md) for the signed-in owner: their own notes,
// relations, importance and catch-up about a person. Noos owns every rule of
// the overlay; Unlinked only names the person (refs) and shapes the answer for
// its pages. Nothing here is ever rendered into a public page, the public
// projection, a cache, the search index or model context: the browser fetches
// it from a separate owner-only, no-store endpoint (docs/private-context.md).

export const OVERLAY_APP = 'unlinked'
export const OVERLAY_AUDIENCE = 'noos-people-overlay'
// Noos permits eight refs per entity. Never fan out an ambiguous identity
// into unbounded remote lookups; explicit entity IDs remain available.
export const MAX_PRIVATE_PERSON_REFS = 8
const HASH = /^[a-f0-9]{64}$/
const ENTITY_ID = /^[A-Za-z0-9_-]{1,80}$/

export class OverlayUnavailable extends Error { constructor(code = 'overlay_unavailable') { super(code); this.code = code } }

// The same claims as Noos `signOverlayAssertion` (src/overlay/auth.ts): this
// backend has verified the person's sign-in and acts for that exact issuer and
// subject. Lives one minute; Noos accepts at most two.
export async function signOverlayAssertion(app, secret, owner) {
  const claims = owner === 'purge' ? { purpose: 'purge' } : { purpose: 'owner', owner_iss: owner.issuer }
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(app).setAudience(OVERLAY_AUDIENCE).setIssuedAt().setExpirationTime('60s')
  if (owner !== 'purge') jwt = jwt.setSubject(owner.subject)
  return jwt.sign(new TextEncoder().encode(secret))
}

// HTTP client for the overlay, server to server only. A missing entity is
// null; everything else that is not a clean answer is OverlayUnavailable and
// never carries a response body (it can quote private content).
export function createOverlayClient({ baseUrl, secret, app = OVERLAY_APP, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('overlay_secret_required')
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('overlay_url_invalid')
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  const call = async (identity, method, path, body) => {
    if (!identity || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string' || !identity.issuer || !identity.subject) throw new OverlayUnavailable('overlay_identity_required')
    const token = await signOverlayAssertion(app, secret, identity)
    let response
    try {
      response = await fetchImpl(new URL(path, root), { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new OverlayUnavailable() }
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new OverlayUnavailable() }
    try { return await response.json() } catch { throw new OverlayUnavailable() }
  }
  // Writes and owner-scoped reads for agent tools (account-tools.mjs). Noos
  // owns every rule; a 4xx answer comes back as { status, body } so the tool
  // can name the overlay's own code (ambiguous_name with the owner's own
  // candidates, invalid_relation, not_found …). 5xx and transport failures
  // are OverlayUnavailable, without the body.
  const request = async (identity, method, path, body) => {
    if (!identity || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string' || !identity.issuer || !identity.subject) throw new OverlayUnavailable('overlay_identity_required')
    const token = await signOverlayAssertion(app, secret, identity)
    let response
    try {
      response = await fetchImpl(new URL(path, root), { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new OverlayUnavailable() }
    if (response.status >= 500 || response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); throw new OverlayUnavailable() }
    if (response.status === 204) return { status: 204, body: null }
    let value
    try { value = await response.json() } catch { throw new OverlayUnavailable() }
    return { status: response.status, body: value }
  }
  return {
    request,
    async search(identity, query) {
      return call(identity, 'GET', `entity-pages?kind=person&limit=8&q=${encodeURIComponent(query)}`)
    },
    async get(identity, entityId) {
      if (!ENTITY_ID.test(entityId)) return null
      return (await call(identity, 'GET', `entities/${encodeURIComponent(entityId)}`))?.entity ?? null
    },
    async lookup(identity, ref) { return (await call(identity, 'POST', 'lookup', { ref }))?.entity ?? null },
    async neighbourhood(identity, entityId, depth = 1) {
      if (!ENTITY_ID.test(entityId)) return null
      return call(identity, 'GET', `entities/${encodeURIComponent(entityId)}/neighbourhood?depth=${depth === 2 ? 2 : 1}`)
    },
    async exportOwner(identity) { return call(identity, 'GET', 'export') },
  }
}

// Who wrote it, in words. Older records (before 2026-10-09) carry no provenance.
export function provenanceLabel({ author, source, assertion } = {}) {
  const agent = typeof author === 'string' && author.startsWith('agent:') ? author.slice(6).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || 'an agent' : null
  let label = null
  if (agent) label = source === 'connector' ? `Added by ${agent} via your Ideaflow connector` : source === 'direct-key' ? `Added by ${agent} with an API key` : `Added by ${agent}`
  else if (author === 'owner') label = source === 'suggestion' ? 'Suggested, then accepted by you' : 'Added by you'
  if (assertion === 'inferred') label = label ? `${label} · inferred` : 'Inferred'
  return label
}

const refOf = {
  person: id => `unlinked:person:${id}`,
  linkedin: hash => `linkedin:in:${hash}`,
}
const PERSON_REF = /^unlinked:person:(.{1,160})$/
const LINKEDIN_REF = /^linkedin:in:([a-f0-9]{64})$/
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null
export function privateSourceSummary(source) {
  const labels = { 'facebook-network-archive': 'Facebook archive', 'imessage-knowledge-wiki:historical': 'Historical iMessage profile', 'matrix-retained:whatsapp': 'WhatsApp archive', 'matrix-retained:instagram': 'Instagram archive', 'matrix-retained:messenger': 'Messenger archive' }
  const raw = String(source?.source ?? '')
  const label = labels[raw] ?? (raw.startsWith('google-contacts:') ? 'Google Contacts' : raw.startsWith('apple-m5:') ? 'Apple Contacts' : raw.startsWith('linkedin-connections:') ? 'LinkedIn export' : raw.startsWith('unlinked-connections:') ? 'Unlinked contacts' : 'Additional source')
  const data = source?.data ?? {}
  const links = (Array.isArray(data.details) ? data.details : []).filter(x => x.kind === 'social' || x.kind === 'website').slice(0, 8).flatMap(x => {
    try { const url = new URL(x.value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? [{ label: String(x.label || 'Profile').slice(0, 80), href: url.href }] : [] } catch { return [] }
  })
  const observedAt = iso(data.provenance?.capturedAt) ?? (typeof data.lastObservedAtNs === 'number' && Number.isFinite(data.lastObservedAtNs) && Math.abs(data.lastObservedAtNs / 1e6) <= 8640000000000000 ? new Date(data.lastObservedAtNs / 1e6).toISOString() : null)
  return { label, updatedAt: iso(source?.updatedAt), observedAt, needsIdentityReview: data.needsIdentityReview === true,
    coverage: typeof data.coverage === 'string' ? data.coverage.slice(0, 400) : null,
    archiveReference: typeof data.archiveNodeId === 'string' ? 'Original evidence retained in your private Noos archive' : data.recordType === 'archive-reference' ? 'Original profile retained in your local archive' : null, links }
}

// `identityFor(owner)` returns the owner's verified Ideaflow {issuer, subject}
// or null. `lookupContact(owner, input)` is the owner-scoped
// unlinked_lookup_contact (connectionId | profileId | refHashes); it never
// reads another owner's imports.
export function createPrivateContext({ overlay, identityFor, lookupContact, now = () => Date.now(), contactPath = id => `/network/contacts/${encodeURIComponent(id)}` }) {
  if (typeof identityFor !== 'function' || typeof lookupContact !== 'function') throw new Error('private_context_configuration_required')
  const configured = Boolean(overlay)
  const identity = async owner => {
    if (!configured) throw new OverlayUnavailable('overlay_not_configured')
    const value = await identityFor(owner).catch(() => { throw new OverlayUnavailable() })
    return value && typeof value.issuer === 'string' && typeof value.subject === 'string' ? value : null
  }
  const contact = async (owner, input) => { try { return await lookupContact(owner, input) } catch { return null } }
  const identityContact = async (owner, input) => {
    try { return await lookupContact(owner, input) }
    catch (error) { if (error?.code === 'not_found') return null; throw new OverlayUnavailable() }
  }
  // Where a relation's other end lives in Unlinked, for the owner: a published
  // profile, else their own imported contact (at its owner-private slug when
  // it has one, docs/contact-slugs.md); other ends are plain text.
  const hrefsFor = async (owner, ends) => {
    const hrefs = new Map(), hashes = new Map()
    for (const end of ends) {
      const refs = Array.isArray(end.refs) ? end.refs : []
      const person = refs.map(ref => PERSON_REF.exec(ref)?.[1]).find(Boolean)
      if (person) { hrefs.set(end.id, profilePath(person)); continue }
      const hash = refs.map(ref => LINKEDIN_REF.exec(ref)?.[1]).find(Boolean)
      if (hash) hashes.set(hash, [...(hashes.get(hash) ?? []), end.id])
    }
    if (hashes.size) {
      const found = await contact(owner, { refHashes: [...hashes.keys()].slice(0, 100) })
      for (const value of Array.isArray(found?.contacts) ? found.contacts : []) {
        const href = value.publishedProfileId ? profilePath(value.publishedProfileId) : value.connectionId ? contactPath(value.connectionId) : null
        for (const id of hashes.get(value.linkedinRefHash) ?? []) if (href) hrefs.set(id, href)
      }
    }
    return hrefs
  }
  const catchUp = card => {
    if (!card || (card.cadenceDays == null && !card.lastContactAt)) return null
    const nextDueAt = iso(card.nextDueAt)
    return { cadenceDays: Number.isSafeInteger(card.cadenceDays) ? card.cadenceDays : null, lastContactAt: iso(card.lastContactAt), nextDueAt, due: nextDueAt ? Date.parse(nextDueAt) <= now() : false }
  }
  const shape = (entity, hrefs) => ({
    id: entity.id, kind: entity.kind, name: String(entity.name ?? ''),
    // The owner's one-line summary of the person (overlay description), as OpenChat shows it.
    description: typeof entity.description === 'string' && entity.description.trim() ? entity.description.slice(0, 280) : null,
    important: entity.card?.important === true, catchUp: catchUp(entity.card),
    sources: (Array.isArray(entity.contactSources) ? entity.contactSources : []).slice(0, 16).map(privateSourceSummary),
    sourcesTruncated: (entity.contactSources?.length ?? 0) > 16,
    notes: (Array.isArray(entity.notes) ? entity.notes : []).map(note => ({ text: String(note.text ?? ''), createdAt: iso(note.createdAt), label: provenanceLabel(note) })),
    relations: (Array.isArray(entity.links) ? entity.links : []).map(link => ({ relation: String(link.relation ?? ''), relationType: link.relationType ?? 'other', direction: link.direction === 'in' ? 'in' : 'out',
      other: { name: String(link.other?.name ?? ''), kind: link.other?.kind ?? 'person', href: hrefs.get(link.other?.id) ?? null }, label: provenanceLabel(link) })),
  })
  // Every ref that may name this person for this owner; each entity once.
  const read = async (owner, refs) => {
    refs = [...new Set(refs)]
    if (refs.length > MAX_PRIVATE_PERSON_REFS) throw new OverlayUnavailable('private_identity_limit')
    const who = await identity(owner)
    if (!who) return { state: 'no_identity' }
    const seen = new Map()
    for (const ref of refs) {
      let found
      try { found = await overlay.lookup(who, ref) } catch (error) { throw error instanceof OverlayUnavailable ? error : new OverlayUnavailable() }
      if (found?.id && !seen.has(found.id)) seen.set(found.id, found)
    }
    const entities = [...seen.values()]
    if (!entities.length) return { state: 'empty' }
    const hrefs = await hrefsFor(owner, entities.flatMap(entity => (entity.links ?? []).map(link => link.other ?? {})))
    return { state: 'ready', entities: entities.map(entity => shape(entity, hrefs)) }
  }
  return {
    configured,
    // Name search returns candidates, never identity bindings. No source data
    // is searched or fetched until the owner explicitly opens this control.
    async search(owner, query) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120 || /[\x00-\x1f\x7f]/.test(query)) return null
      const who = await identity(owner)
      if (!who) return { state: 'no_identity' }
      if (!overlay.search) throw new OverlayUnavailable()
      const page = await overlay.search(who, query.trim())
      return { state: 'ready', candidates: (page?.entities ?? []).filter(x => x.kind === 'person').slice(0, 8).map(x => ({ id: x.id, name: String(x.name ?? ''), description: typeof x.description === 'string' ? x.description.slice(0, 280) : null })), truncated: Boolean(page?.nextCursor) }
    },
    async forEntity(owner, entityId) {
      if (!ENTITY_ID.test(entityId)) return null
      const who = await identity(owner)
      if (!who) return { state: 'no_identity' }
      if (!overlay.get) throw new OverlayUnavailable()
      const entity = await overlay.get(who, entityId)
      if (!entity || entity.kind !== 'person') return null
      const hrefs = await hrefsFor(owner, (entity.links ?? []).map(x => x.other ?? {}))
      return { state: 'ready', entities: [shape(entity, hrefs)] }
    },
    // A published profile: its own ref and exact public/owner-import LinkedIn
    // identity. A private prospect can predate this public profile entirely.
    async forProfile(owner, profileId) {
      if (typeof profileId !== 'string' || !profileId || profileId.length > 160) return { state: 'empty' }
      const found = await identityContact(owner, { profileId })
      const hash = HASH.test(found?.contact?.linkedinRefHash ?? '') ? found.contact.linkedinRefHash : null
      return read(owner, [refOf.person(profileId), ...((found?.contact?.publishedProfileIds ?? []).filter(Boolean).map(refOf.person)), ...(found?.contact?.publishedProfileId && found.contact.publishedProfileId !== profileId ? [refOf.person(found.contact.publishedProfileId)] : []), ...(hash ? [refOf.linkedin(hash)] : []), ...([...new Set([found?.contact?.sourceLinkedinRefHash, ...(found?.contact?.sourceLinkedinRefHashes ?? [])])].filter(value => HASH.test(value ?? '')).map(refOf.linkedin))])
    },
    // One of the owner's own imported contacts; null when it is not theirs.
    async forContact(owner, connectionId) {
      const found = await identityContact(owner, { connectionId })
      if (!found?.contact || found.visibility !== 'owner_private') return null
      const refs = [...(HASH.test(found.contact.linkedinRefHash ?? '') ? [refOf.linkedin(found.contact.linkedinRefHash)] : []),
        ...([...new Set([found.contact.sourceLinkedinRefHash, ...(found.contact.sourceLinkedinRefHashes ?? [])])].filter(value => HASH.test(value ?? '')).map(refOf.linkedin)),
        ...([...new Set([found.contact.publishedProfileId, ...(found.contact.publishedProfileIds ?? [])])].filter(Boolean).map(refOf.person))]
      return refs.length ? read(owner, refs) : { state: 'empty' }
    },
    async neighbourhood(owner, entityId, depth) {
      const who = await identity(owner)
      if (!who) return { state: 'no_identity' }
      let value
      try { value = await overlay.neighbourhood(who, entityId, depth) } catch (error) { throw error instanceof OverlayUnavailable ? error : new OverlayUnavailable() }
      if (!value?.center) return null
      const all = [value.center, ...(value.entities ?? [])]
      const hrefs = await hrefsFor(owner, all)
      const names = new Map(all.map(entity => [entity.id, { name: String(entity.name ?? ''), kind: entity.kind, href: hrefs.get(entity.id) ?? null }]))
      return { state: 'ready', depth: value.depth === 2 ? 2 : 1, truncated: value.truncated === true, center: names.get(value.center.id),
        links: (value.links ?? []).filter(link => names.has(link.fromId) && names.has(link.toId)).map(link => ({ from: names.get(link.fromId), relation: String(link.relation ?? ''), relationType: link.relationType ?? 'other', to: names.get(link.toId), label: provenanceLabel(link) })) }
    },
    // The owner's whole overlay for their Unlinked export (their own data).
    async exportOwner(owner) {
      const who = await identity(owner)
      return who ? overlay.exportOwner(who) : null
    },
  }
}

// Browser-side renderer for `[data-private-context]` mounts. Builds DOM with
// textContent only; the endpoint's JSON never becomes markup.
export const PRIVATE_CONTEXT_SCRIPT = `(()=>{
const mounts=[...document.querySelectorAll('[data-private-context]')];if(!mounts.length)return;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n};
const day=v=>{try{return new Date(v).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}catch{return ''}};
const link=(end)=>{if(end&&end.href&&/^\\/(people|network\\/contacts)\\//.test(end.href)){const a=el('a',null,end.name||'Unnamed');a.href=end.href;return a}return el('span',null,(end&&end.name)||'Unnamed')};
const KEY='unlinked.private-context.open.v1';
const remembered=()=>{try{return localStorage.getItem(KEY)}catch{return null}};
const hint=name=>{const p=el('p','small pc-hint');p.append('Tell your agent (for example Claude with the ',Object.assign(el('a',null,'Ideaflow connector'),{href:'/agents'}),') or OpenChat what you know about '+(name||'this person')+': notes, who they know, what they work on. It shows up here, and only you can see it.');return p};
const moreRecords=(mount)=>{const name=(mount.dataset.name||'').trim();if(name.length<2||name.length>120)return;const box=el('details','pc-more');box.append(el('summary',null,'More context across your records'));const out=el('div');box.append(el('p','small','Search your private source records for '+name+'. Same-name results are possible matches, not linked identities.'),out);let loaded=false;box.addEventListener('toggle',async()=>{if(!box.open||loaded)return;loaded=true;out.replaceChildren(el('p','small','Finding private records…'));try{const r=await fetch('/api/private-context/search?q='+encodeURIComponent(name),{credentials:'same-origin',cache:'no-store'});const j=await r.json();if(!r.ok||j.state!=='ready')throw 0;out.replaceChildren();for(const record of j.candidates||[]){const item=el('details','pc-source-record');item.append(el('summary',null,record.name||'Unnamed record'));const body=el('div');item.append(body);let opened=false;item.addEventListener('toggle',async()=>{if(!item.open||opened)return;opened=true;body.replaceChildren(el('p','small','Loading private source context…'));try{const res=await fetch('/api/private-context/records/'+encodeURIComponent(record.id),{credentials:'same-origin',cache:'no-store'});const value=await res.json();if(!res.ok||value.state!=='ready')throw 0;render(body,value,true)}catch{opened=false;body.replaceChildren(el('p','small','Could not load this private record. Close and reopen to retry.'))}});out.append(item)}if(!(j.candidates||[]).length)out.append(el('p','small','No matching private records found.'));if(j.truncated)out.append(el('p','small','Showing the first eight possible matches.'))}catch{loaded=false;out.replaceChildren(el('p','small','Private record search is unavailable. Close and reopen to retry.'))}});mount.append(box)};
const render=(mount,data,nested=false)=>{mount.replaceChildren();mount.hidden=false;const name=mount.dataset.name||'';
 const head=el('div','pc-head');head.append(el('h3',null,'Your private context'),el('span','pc-only','Only you'));
 if(data.state==='empty'||data.state==='no_identity'){mount.append(head,el('p','small',data.state==='no_identity'?'Private context needs your Ideaflow sign-in. Sign out and sign in again to see it.':'Nothing saved about '+(name||'this person')+' yet.'));if(data.state==='empty'){mount.append(hint(name));if(!nested)moreRecords(mount)}return}
 if(data.state!=='ready'){mount.append(head,el('p','small','Your private context is unavailable right now. Try again in a minute.'));return}
 const notes=data.entities.reduce((n,e)=>n+e.notes.length,0),rels=data.entities.reduce((n,e)=>n+e.relations.length,0);
 const box=el('details','pc-box');const sum=el('summary');sum.append(el('b',null,'Your private context'),el('span','small',' · '+[notes?notes+(notes===1?' note':' notes'):'',rels?rels+(rels===1?' relation':' relations'):'',data.entities.some(e=>e.important)?'important':''].filter(Boolean).join(' · ')||'saved'),el('span','pc-only','Only you'));box.append(sum);
 const r=remembered();box.open=r===null?true:r==='1';box.addEventListener('toggle',()=>{try{localStorage.setItem(KEY,box.open?'1':'0')}catch{}});
 for(const e of data.entities){const sec=el('div','pc-entity');if(data.entities.length>1)sec.append(el('h4',null,e.name));
  const facts=[];if(e.important)facts.push('★ Important to you');if(e.catchUp){if(e.catchUp.cadenceDays)facts.push('Catch up every '+e.catchUp.cadenceDays+' days');if(e.catchUp.lastContactAt)facts.push('last '+day(e.catchUp.lastContactAt));if(e.catchUp.due)facts.push('due now');else if(e.catchUp.nextDueAt)facts.push('next '+day(e.catchUp.nextDueAt))}
  if(e.description)sec.append(el('p','pc-desc',e.description));
  if((e.sources||[]).length){const sources=el('details','pc-sources');sources.append(el('summary',null,'Sources · '+e.sources.length));for(const source of e.sources){const row=el('div','pc-source');row.append(el('strong',null,source.label));if(source.observedAt)row.append(el('p','small','Source observed '+day(source.observedAt)));else row.append(el('p','small','Source date unknown'));if(source.coverage)row.append(el('p','small',source.coverage));if(source.needsIdentityReview)row.append(el('p','small','Identity match needs review'));if(source.archiveReference)row.append(el('p','small',source.archiveReference));for(const dest of source.links||[]){try{const url=new URL(dest.href);if(url.protocol!=='https:'||url.username||url.password)continue;const a=el('a',null,dest.label);a.href=url.href;a.rel='noreferrer noopener';row.append(a)}catch{}}sources.append(row)}if(e.sourcesTruncated)sources.append(el('p','small','Showing the first 16 sources.'));sec.append(sources)}
  if(facts.length)sec.append(el('p','pc-facts'+(e.catchUp&&e.catchUp.due?' due':''),facts.join(' · ')));
  if(e.notes.length){const ul=el('ul','pc-notes');for(const n of e.notes){const li=el('li');li.append(el('p',null,n.text));const meta=[n.label,n.createdAt?day(n.createdAt):''].filter(Boolean).join(' · ');if(meta)li.append(el('span','small',meta));ul.append(li)}sec.append(el('h5',null,'Notes'),ul)}
  if(e.relations.length){const ul=el('ul','pc-rels');for(const x of e.relations){const li=el('li'),line=el('span','pc-rel');if(x.direction==='in'){line.append(link(x.other),' '+x.relation+' ',el('span',null,e.name))}else{line.append(el('span',null,e.name),' '+x.relation+' ',link(x.other))}li.append(line);if(x.label)li.append(el('span','small',x.label));ul.append(li)}sec.append(el('h5',null,'Relations'),ul)}
  if(e.relations.length){const b=el('button','quiet sm pc-explore','Explore 2 hops');b.type='button';const out=el('div','pc-hood');b.addEventListener('click',async()=>{b.disabled=true;out.replaceChildren(el('p','small','Loading…'));try{const res=await fetch('/api/private-context/entities/'+encodeURIComponent(e.id)+'/neighbourhood?depth=2',{credentials:'same-origin',cache:'no-store'});const j=await res.json();if(!res.ok||j.state!=='ready')throw 0;const ul=el('ul','pc-rels');for(const l of j.links){const li=el('li'),line=el('span','pc-rel');line.append(link(l.from),' '+l.relation+' ',link(l.to));li.append(line);ul.append(li)}out.replaceChildren(el('h5',null,'Within two steps'),ul);if(j.truncated)out.append(el('p','small','Showing the first part of a larger web.'))}catch{out.replaceChildren(el('p','small','Could not load the wider web right now.'));b.disabled=false}});sec.append(b,out)}
  if(!e.notes.length&&!e.relations.length&&!facts.length)sec.append(el('p','small','Saved, with no notes yet.'));
  box.append(sec)}
 box.append(hint(name));mount.append(box);if(!nested)moreRecords(mount)};
for(const mount of mounts){mount.hidden=false;mount.replaceChildren(el('p','small pc-loading','Loading your private context…'));
 fetch(mount.dataset.privateContext,{credentials:'same-origin',cache:'no-store'}).then(async r=>{const j=await r.json().catch(()=>({state:'unavailable'}));render(mount,r.ok||r.status===503?j:{state:'unavailable'})}).catch(()=>render(mount,{state:'unavailable'}))}
})();`
