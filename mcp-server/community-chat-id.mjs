import { createHash } from 'node:crypto'
export const communityChatId = group => group.chatConversationId ?? `uc_${createHash('sha256').update(group.id).digest('hex').slice(0,32)}`
export const GROUP_KEY = '(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,99})'
export const readableGroupSlug = (name,id) => `${name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70).replace(/-$/,'') || 'group'}-${id.slice(0,8)}`
export const groupUrlKey = group => group.urlMode === 'opaque' ? group.id : group.slug ?? group.id
