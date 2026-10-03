import { signupReservation, signupProfileId } from '../../mcp-server/signup-linkedin.mjs'
// State fixture consumes the same reservation policy as the transactional store.
export function memorySignupStore() {
  const accounts = new Map(), cache = new Map(), sources = new Map()
  let gate = { day: -1, used: 0, nextAt: 0 }, active = true
  const inactive = new Set(), isActive = owner => active && !inactive.has(owner.ownerId)
  const claimed = ({ key, slug }) => [...sources.entries()].some(([otherKey, row]) => otherKey !== key && row.slug === slug && !row.retired && isActive(row.owner))
  return {
    accounts, cache, sources, setActive: value => { active = value },
    setOwnerActive: (owner, value) => {
      if (value) inactive.delete(owner.ownerId)
      else { inactive.add(owner.ownerId); for (const row of sources.values()) if (row.owner.ownerId === owner.ownerId) { row.retired = true; delete row.activeSlug } }
    },
    async reserve(args) {
      if (claimed(args)) return { code: 'slug_claimed' }
      const account = accounts.get(args.key) ?? { attempts: 0 }
      const decision = signupReservation({ account, gate, cached: cache.get(args.slug) }, args)
      if (decision.profile) accounts.set(args.key, { ...account, slug: args.slug, succeeded: true, json: JSON.stringify(decision.profile) })
      if (decision.allowed) {
        gate = { day: args.day, used: decision.used, nextAt: args.now + args.pacingMs, pendingUntil: args.now + args.timeoutMs + 15000 }
        accounts.set(args.key, { ...account, attempts: account.attempts + 1, slug: args.slug, attempt: args.attempt, pendingUntil: gate.pendingUntil })
      }
      return decision
    },
    async finish({ key, slug, attempt, profile, now, pacingMs }) {
      const account = accounts.get(key)
      if (!account || account.attempt !== attempt) return false
      account.pendingUntil = 0; gate.pendingUntil = 0; gate.nextAt = now + pacingMs
      if (profile) { account.succeeded = true; account.json = JSON.stringify(profile); cache.set(slug, account.json) }
      if (profile && claimed({ key, slug })) return { code: 'slug_claimed' }
      return true
    },
    async confirm({ key, owner, slug, profileId, receiptId }) {
      const account = accounts.get(key)
      if (!isActive(owner) || !account?.json || account.slug !== slug || sources.get(key)?.retired || claimed({ key, slug })) return false
      if (!sources.has(key)) sources.set(key, { owner, slug, activeSlug: slug, profile: { ...JSON.parse(account.json), id: profileId }, receiptId })
      return true
    },
    async removeOwner(owner) {
      const id = signupProfileId(owner), key = id.slice('member-linkedin-'.length)
      sources.delete(key)
      const account = accounts.get(key)
      if (account) accounts.set(key, { attempts: account.attempts, succeeded: Boolean(account.succeeded || account.json) })
    },
    async read(owner, { includeRetired = false } = {}) { return isActive(owner) ? [...sources.values()].find(row => row.profile.id === signupProfileId(owner) && (includeRetired || !row.retired)) ?? null : null },
    async list() { return [...sources.values()].filter(row => isActive(row.owner) && !row.retired) },
  }
}
