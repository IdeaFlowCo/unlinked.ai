import { createPublicSearchRelay } from '@/utils/public-search-relay.mjs'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const relay = createPublicSearchRelay()
export const GET = relay
export const HEAD = relay
