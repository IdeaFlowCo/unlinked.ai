import { signupReservation, signupProfileId } from '../../mcp-server/signup-linkedin.mjs'
// State fixture consumes the same reservation policy as the transactional store.
export function memorySignupStore() {
  const accounts = new Map(), cache = new Map(), sources = new Map()
  let gate = { day: -1, used: 0, nextAt: 0 }, active = true
  return {
    accounts, cache, sources, setActive: value => { active = value },
    async reserve(args) {
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
      return true
    },
    async confirm({ key, owner, slug, profileId, receiptId }) {
      const account = accounts.get(key)
      if (!active || !account?.json || account.slug !== slug) return false
      if (!sources.has(key)) sources.set(key, { owner, profile: { ...JSON.parse(account.json), id: profileId }, receiptId })
      return true
    },
    async removeOwner(owner) {
      const id = signupProfileId(owner), key = id.slice('member-linkedin-'.length)
      sources.delete(key)
      const account = accounts.get(key)
      if (account) accounts.set(key, { attempts: account.attempts, succeeded: Boolean(account.succeeded || account.json) })
    },
    async read(owner) { return active ? [...sources.values()].find(row => row.profile.id === signupProfileId(owner)) ?? null : null },
    async list() { return active ? [...sources.values()] : [] },
  }
}
