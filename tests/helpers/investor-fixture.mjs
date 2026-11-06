import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createPrivateNotesTools } from '../../mcp-server/private-notes-tools.mjs'
import { AccountToolError } from '../../mcp-server/account-tools.mjs'
import { createPublicPeopleReader } from '../../src/utils/public-people/reader.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
export function fixture(customOverlay) {
  const owners = new Map(), resources = new Map(), assets = new Map()
  let sequence = 0, failReceipt = false, failNote = false, notePause = null
  const state = id => { if (!owners.has(id)) owners.set(id, { entities: new Map(), notes: new Map(), links: new Map() }); return owners.get(id) }
  const overlay = { async request(identity, method, path, body) {
    const s = state(identity.subject), parts = path.split('/')
    if (path === 'lookup') { const entity = [...s.entities.values()].find(e => e.refs.includes(body.ref)); return entity ? { status: 200, body: { entity } } : { status: 404, body: { error: 'not_found' } } }
    if (path === 'entities' && method === 'POST') {
      const refs = body.refs ?? [`unlinked:private:${sha(body.clientRequestId).slice(0, 32)}`]
      const found = [...s.entities.values()].find(e => e.refs.some(r => refs.includes(r)))
      if (found) return { status: 200, body: { entity: found, created: false, unattached: [] } }
      const entity = { id: `entity-${++sequence}`, kind: body.kind, name: body.name, refs }
      s.entities.set(entity.id, entity); return { status: 201, body: { entity, created: true, unattached: [] } }
    }
    const entity = s.entities.get(parts[1])
    if (!entity) return { status: 404, body: { error: 'not_found' } }
    if (method === 'GET') return { status: 200, body: { entity } }
    if (parts[2] === 'notes') {
      if (notePause) { const pending = notePause; notePause = null; pending.enter(); await pending.wait }
      if (failNote) { failNote = false; throw new Error('synthetic_outage') }
      const key = `${entity.id}:${body.text}`
      if (!s.notes.has(key)) s.notes.set(key, { id: `note-${++sequence}`, ...body })
      return { status: 201, body: { note: s.notes.get(key) } }
    }
    if (parts[2] === 'links') {
      assert.equal(body.relation, 'contains'); assert.equal(entity.kind, 'list'); assert.ok(s.entities.has(body.toId))
      const key = `${entity.id}:${body.relation}:${body.toId}`
      if (!s.links.has(key)) s.links.set(key, { id: `link-${++sequence}`, fromId: entity.id, ...body })
      return { status: 201, body: { link: s.links.get(key) } }
    }
    throw Error('unexpected_overlay_request')
  } }
  const applyResource = (owner, input, target) => {
      assert.equal(input.sourceOwnerId, owner.ownerId); assert.equal(input.audience, 'owner')
      assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 65536)
      const key = `${owner.ownerId}:${input.sourceId}`, old = target.get(key)
      if (old?.deleted || (old?.sourceRevision ?? null) !== input.expectedRevision) throw Error('private_noos_409')
      if (failReceipt && input.payload?.kind === 'investor_csv_v1_row') { failReceipt = false; throw Error('synthetic_receipt_outage') }
      target.set(key, structuredClone(input))
  }
  const getBackend = async owner => ({
    async readResource(type, id) { assert.equal(type, 'import'); return structuredClone(resources.get(`${owner.ownerId}:${id}`) ?? null) },
    async writeResource(input) { applyResource(owner, input, resources) },
    async writeImportBatch(items) {
      const transaction = new Map(resources)
      for (const item of items) applyResource(owner, item, transaction)
      for (const item of items) { const key = `${owner.ownerId}:${item.sourceId}`; resources.set(key, transaction.get(key)) }
    },
    adapter: { async withImport(ownerId, id, work) { assert.equal(ownerId, owner.ownerId); return work({ async putAsset(hash, bytes) { assets.set(`${ownerId}:${hash}`, Buffer.from(bytes)) } }) } },
    async readAsset(hash) { const bytes = assets.get(`${owner.ownerId}:${hash}`); assert.ok(bytes); return bytes },
  })
  const publicReader = createPublicPeopleReader({ readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'synthetic-empty', profiles: [], connections: [] }) })
  const options = { getBackend, overlay: customOverlay ?? overlay, identityFor: async owner => ({ issuer: 'https://synthetic.invalid', subject: owner.ownerId }),
    lookupContact: async (_grant, input, signal) => { if (input.linkedinUrl) await publicReader.lookupLinkedin({ address: input.linkedinUrl, signal }); throw new AccountToolError('not_found', 'Synthetic no public profile') }, createError: (code, message, details) => new AccountToolError(code, message, details) }
  return { resources, assets, state, getBackend, options, tools: () => createPrivateNotesTools(options), pauseNote: () => { let enter, release; const entered = new Promise(resolve => { enter = resolve }); const wait = new Promise(resolve => { release = resolve }); notePause = { enter, wait }; return { entered, release } }, failReceipt: () => { failReceipt = true }, failNote: () => { failNote = true } }
}
