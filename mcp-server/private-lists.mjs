// Browser-only, read-only projection of existing owner-private graph lists.
// The tool service owns identity, permission checks and pagination. Never copy
// these records into saved-search sharing, public profiles or a second store.
export const PRIVATE_LIST_READ_TOOLS = Object.freeze(['unlinked_list_private_things', 'unlinked_get_private_thing'])
const ID = /^[A-Za-z0-9_-]{1,80}$/
const fail = code => Object.assign(new Error(code), { code })
export function createPrivateLists({ call }) {
  if (typeof call !== 'function') throw new TypeError('private_lists_configuration_required')
  const pageInput = after => {
    if (after !== undefined && (typeof after !== 'string' || !after || after.length > 512)) throw fail('invalid_input')
    return { limit: 50, ...(after ? { after } : {}) }
  }
  return {
    async list(owner, after) {
      const result = await call(owner, 'unlinked_list_private_things', { kind: 'list', ...pageInput(after) })
      return { lists: (result.entities ?? []).filter(entity => entity.kind === 'list'), nextCursor: result.nextCursor ?? null }
    },
    async get(owner, id, after) {
      if (!ID.test(id)) throw fail('not_found')
      const result = await call(owner, 'unlinked_get_private_thing', { thingId: id, ...pageInput(after) })
      if (result.entity?.kind !== 'list') throw fail('not_found')
      return { list: result.entity, members: (result.entity.links ?? []).filter(link => link.direction === 'out' && link.relation === 'contains' && link.other?.kind === 'person').map(link => link.other), nextCursor: result.nextCursor ?? null }
    },
  }
}
