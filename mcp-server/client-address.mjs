import { BlockList, isIP } from 'node:net'

// Cloudflare's published edge ranges (https://api.cloudflare.com/client/v4/ips,
// etag 38f79d050aa027e3be3865e495dcc9bc, read 2026-11-02). www.unlinked.ai is
// proxied through Cloudflare, so the ingress peer is an edge address shared by
// many visitors. Only a request whose peer is one of these ranges may name its
// visitor with CF-Connecting-IP; anyone else reaching the origin directly is
// keyed by its own peer, so the header cannot be used to mint fresh budgets.
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']

export function cloudflareEdges() {
  const list = new BlockList()
  for (const range of CLOUDFLARE_V4) { const [address, prefix] = range.split('/'); list.addSubnet(address, Number(prefix), 'ipv4') }
  for (const range of CLOUDFLARE_V6) { const [address, prefix] = range.split('/'); list.addSubnet(address, Number(prefix), 'ipv6') }
  return list
}

const EDGES = cloudflareEdges()

function plain(value) {
  if (typeof value !== 'string') return null
  const address = value.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')
  return isIP(address) ? address : null
}

function single(header) {
  return typeof header === 'string' && !header.includes(',') ? plain(header) : null
}

// One IPv6 subscriber usually holds a whole /64; keying the full address would
// let a single host rotate through unlimited budgets.
function bucket(address) {
  if (isIP(address) === 4) return address
  const groups = expand(address)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : address
}

function expand(address) {
  const [head, tail = ''] = address.toLowerCase().split('::')
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : []
  if (address.includes('.')) return null
  const missing = 8 - left.length - right.length
  if (!address.includes('::') && missing !== 0) return null
  return [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map(group => group.padStart(4, '0'))
}

// The ingress overwrites X-Forwarded-For with its TCP peer, so that value is
// the peer; the socket address is the fallback for direct (test/dev) calls.
// Returns an opaque rate-limit key held only in memory, or null when unknown.
export function visitorKey(request, { edges = EDGES } = {}) {
  const peer = single(request.headers?.['x-forwarded-for']) ?? plain(request.socket?.remoteAddress)
  if (!peer) return null
  const family = isIP(peer) === 4 ? 'ipv4' : 'ipv6'
  if (edges.check(peer, family)) {
    const visitor = single(request.headers?.['cf-connecting-ip'])
    return visitor ? bucket(visitor) : null
  }
  return bucket(peer)
}

// Self-declared crawlers and non-browser clients. Crawlers spread over many
// addresses read slowly per address, so the per-visitor arrival allowance
// cannot tell them from people; their own user agent can. They stay on the
// shared anonymous fuse and never receive arrival or card priority.
const AUTOMATION = /bot\b|bot\/|crawl|spider|slurp|externalhit|headless|preview|scrap|fetch|python|curl|wget|httpclient|http-client|okhttp|java\/|go-http|axios|libwww|monitor|uptime|check|scan(?:ner)?\b|archiver|lighthouse|^$/i

export function declaredAutomation(request) {
  const agent = request.headers?.['user-agent']
  return typeof agent !== 'string' || AUTOMATION.test(agent.trim()) || !/^Mozilla\/5\.0 /.test(agent.trim())
}
