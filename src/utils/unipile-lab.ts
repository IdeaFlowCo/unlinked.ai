import { randomBytes, timingSafeEqual } from 'node:crypto'

export const UNIPILE_API_VERSION = 'v1' as const
const TTL_MS = 10 * 60_000
const LIMIT = 10

export type Outcome = 'ok' | 'empty' | 'partial' | 'denied' | 'unavailable' | 'unsupported'
export type Profile = { id: string; name: string; headline?: string; publicUrl?: string }
export type Preview = { outcome: Outcome; viewedAt: string; mode: 'own' | 'demo'; target?: Profile; people?: Profile[]; note?: string }
export type LabErrorCode = 'invalid' | 'denied' | 'unavailable' | 'unsupported' | 'expired' | 'conflict'
export class LabError extends Error {
  code: LabErrorCode
  constructor(code: LabErrorCode, message: string) { super(message); this.code = code }
}

export function isAllowedTester(enabled: boolean, allowlist: string, userId: string | null): boolean {
  return enabled && !!userId && allowlist.split(',').map(value => value.trim()).filter(Boolean).includes(userId)
}

export function parseLinkedInUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) throw new LabError('invalid', 'Enter a LinkedIn profile URL.')
  let url: URL
  try { url = new URL(value) } catch { throw new LabError('invalid', 'Enter a LinkedIn profile URL.') }
  const match = /^\/in\/([a-zA-Z0-9-]{2,100})\/?$/.exec(url.pathname)
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password || url.search || url.hash || !match) {
    throw new LabError('invalid', 'Only a plain https://www.linkedin.com/in/... profile URL is accepted.')
  }
  return match[1]
}

export interface LabProvider {
  hostedLink(input: { name: string; notifyUrl: string; successUrl: string; failureUrl: string; reconnectAccount?: string }): Promise<string>
  verifyAccount(accountId: string): Promise<void>
  ownProfile(accountId: string): Promise<Profile>
  targetProfile(accountId: string, identifier: string): Promise<Profile>
  ownConnections(accountId: string): Promise<{ people: Profile[]; partial: boolean }>
  targetConnections(accountId: string, targetId: string): Promise<{ people: Profile[]; partial: boolean }>
}

type Pending = { userId: string; secret: string; expires: number; reconnectAccount?: string; used: boolean }
type SourceStatus = 'verified' | 'quarantined'
type UserState = { accountId?: string; ownerProfileId?: string; sourceStatus?: SourceStatus; preview?: Preview; previewExpires?: number; busy?: string; generation?: number }

/** Process-local, expiring test state. Live activation requires a single-instance stage. */
export class UnipileLab {
  private pending = new Map<string, Pending>()
  private pendingByUser = new Map<string, string>()
  private users = new Map<string, UserState>()
  private accountOwners = new Map<string, string>()
  private provider: LabProvider
  private demoAccountId?: string
  private now: () => number
  private allowedTargets?: Set<string>
  constructor(provider: LabProvider, demoAccountId?: string, now = () => Date.now(), allowedTargets?: string[]) {
    this.provider = provider
    this.demoAccountId = demoAccountId
    this.now = now
    this.allowedTargets = allowedTargets ? new Set(allowedTargets) : undefined
  }

  private state(userId: string): UserState {
    const state = this.users.get(userId) ?? {}
    this.users.set(userId, state)
    if (state.previewExpires && state.previewExpires <= this.now()) {
      delete state.preview
      delete state.previewExpires
    }
    return state
  }

  get(userId: string) {
    const state = this.state(userId)
    return { connected: !!state.accountId && state.sourceStatus === 'verified', hasSource: !!state.accountId, sourceStatus: state.sourceStatus ?? 'none', preview: state.preview }
  }

  private async once<T>(userId: string, action: string, fn: (state: UserState) => Promise<T>): Promise<T> {
    const state = this.state(userId)
    if (state.busy) throw new LabError('conflict', 'A preview request is already running.')
    state.busy = action
    try { return await fn(state) } finally { state.busy = undefined }
  }

  async start(userId: string, origin: string, reconnect = false) {
    return this.once(userId, 'start', async state => {
      const activeName = this.pendingByUser.get(userId)
      const active = activeName ? this.pending.get(activeName) : undefined
      if (active && active.expires > this.now()) throw new LabError('conflict', 'A connection is already pending for this tester.')
      if (activeName) { this.pending.delete(activeName); this.pendingByUser.delete(userId) }
      if (reconnect && !state.accountId) throw new LabError('invalid', 'No linked account to reconnect.')
      if (!reconnect && state.accountId) throw new LabError('conflict', 'An account is already linked.')
      const name = randomBytes(24).toString('base64url')
      const secret = randomBytes(24).toString('base64url')
      const reconnectAccount = reconnect ? state.accountId : undefined
      const pending: Pending = { userId, secret, expires: this.now() + TTL_MS, reconnectAccount, used: false }
      this.pending.set(name, pending)
      this.pendingByUser.set(userId, name)
      if (reconnect) this.quarantine(state)
      try {
        const url = await this.provider.hostedLink({
          name,
          notifyUrl: `${origin}/api/unipile-lab/callback?state=${name}&token=${secret}`,
          successUrl: `${origin}/unipile-lab?return=success`,
          failureUrl: `${origin}/unipile-lab?return=failure`,
          reconnectAccount,
        })
        return { url }
      } catch (error) { this.pending.delete(name); this.pendingByUser.delete(userId); throw error }
    })
  }

  async callback(input: { state?: unknown; token?: unknown; name?: unknown; status?: unknown; accountId?: unknown }) {
    const pending = typeof input.state === 'string' ? this.pending.get(input.state) : undefined
    if (!pending || pending.used) throw new LabError('denied', 'Unknown or used connection callback.')
    if (this.now() >= pending.expires) { pending.used = true; throw new LabError('expired', 'Connection link expired.') }
    if (typeof input.token !== 'string' || !safeEqual(input.token, pending.secret) || input.name !== input.state) throw new LabError('denied', 'Connection callback did not match its pending request.')
    // Claim before the first await; simultaneous/replayed notifications cannot race.
    pending.used = true
    const state = this.state(pending.userId)
    const generation = state.generation ?? 0
    try {
      if (input.status !== (pending.reconnectAccount ? 'RECONNECTED' : 'CREATION_SUCCESS')) throw new LabError('denied', 'Connection was not confirmed by the provider.')
      if (typeof input.accountId !== 'string' || !/^[a-zA-Z0-9_-]{4,100}$/.test(input.accountId)) throw new LabError('invalid', 'Invalid provider account.')
      this.checkAssignment(pending, input.accountId, state)
      await this.provider.verifyAccount(input.accountId)
      const own = await this.provider.ownProfile(input.accountId)
      if (!own.id) throw new LabError('unavailable', 'Provider did not verify the account owner.')
      if (pending.reconnectAccount && state.ownerProfileId !== own.id) throw new LabError('denied', 'Reconnected LinkedIn owner did not match this source.')
      // No await between the final checks and writes: distinct callback tokens
      // cannot assign the same account or replace a tester's source concurrently.
      if (this.pendingByUser.get(pending.userId) !== input.state || this.pending.get(input.state as string) !== pending) {
        throw new LabError('conflict', 'Connection callback was superseded.')
      }
      this.checkAssignment(pending, input.accountId, state)
      state.accountId = input.accountId
      state.ownerProfileId = own.id
      state.sourceStatus = 'verified'
      this.accountOwners.set(input.accountId, pending.userId)
      this.save(state, { outcome: 'ok', viewedAt: new Date(this.now()).toISOString(), mode: 'own', target: own }, generation)
    } finally {
      if (this.pendingByUser.get(pending.userId) === input.state) this.pendingByUser.delete(pending.userId)
      this.pending.delete(input.state as string)
    }
  }

  private checkAssignment(pending: Pending, accountId: string, state: UserState) {
    if (pending.reconnectAccount) {
      if (accountId !== pending.reconnectAccount || state.accountId !== accountId || this.accountOwners.get(accountId) !== pending.userId) throw new LabError('denied', 'Reconnect account does not belong to this tester.')
    } else if (state.accountId || this.accountOwners.has(accountId) || accountId === this.demoAccountId) {
      throw new LabError('denied', 'Provider account is already assigned.')
    }
  }

  private quarantine(state: UserState) {
    state.sourceStatus = 'quarantined'
    state.generation = (state.generation ?? 0) + 1
    delete state.preview
    delete state.previewExpires
  }

  private save(state: UserState, preview: Preview, generation: number): Preview | undefined {
    if ((state.generation ?? 0) !== generation) return undefined
    state.preview = preview
    state.previewExpires = this.now() + TTL_MS
    return preview
  }

  async ownConnections(userId: string): Promise<Preview> {
    return this.once(userId, 'ownConnections', async state => {
      if (!state.accountId || state.sourceStatus !== 'verified') throw new LabError('denied', 'LinkedIn source is not verified for reads.')
      if (state.preview?.mode === 'own' && state.preview.people) return state.preview
      const generation = state.generation ?? 0
      const result = await this.provider.ownConnections(state.accountId)
      if (state.sourceStatus !== 'verified') throw new LabError('denied', 'LinkedIn source is not verified for reads.')
      const people = result.people.slice(0, LIMIT)
      const preview = this.save(state, { outcome: result.partial || result.people.length > LIMIT ? 'partial' : people.length ? 'ok' : 'empty', viewedAt: new Date(this.now()).toISOString(), mode: 'own', people }, generation)
      if (!preview) throw new LabError('conflict', 'Preview was cleared during the request.')
      return preview
    })
  }

  async previewTarget(userId: string, rawUrl: unknown): Promise<Preview> {
    return this.once(userId, 'target', async state => {
      const identifier = parseLinkedInUrl(rawUrl)
      if (!this.demoAccountId) throw new LabError('unavailable', 'Demo account is not configured.')
      if (this.allowedTargets && !this.allowedTargets.has(identifier)) throw new LabError('denied', 'This target is not approved for the live test.')
      if (state.preview?.mode === 'demo' && state.preview.target?.publicUrl === `https://www.linkedin.com/in/${identifier}`) return state.preview
      const generation = state.generation ?? 0
      const target = await this.provider.targetProfile(this.demoAccountId, identifier)
      if (!target.id) throw new LabError('unavailable', 'Target profile has no usable provider ID.')
      const preview = this.save(state, { outcome: 'ok', viewedAt: new Date(this.now()).toISOString(), mode: 'demo', target: { ...target, publicUrl: `https://www.linkedin.com/in/${identifier}` } }, generation)
      if (!preview) throw new LabError('conflict', 'Preview was cleared during the request.')
      return preview
    })
  }

  async targetConnections(userId: string): Promise<Preview> {
    return this.once(userId, 'targetConnections', async state => {
      if (!this.demoAccountId) throw new LabError('unavailable', 'Demo account is not configured.')
      const prior = state.preview
      if (!prior || prior.mode !== 'demo' || !prior.target?.id) throw new LabError('invalid', 'Preview a target profile first.')
      if (prior.people) return prior
      const generation = state.generation ?? 0
      // Preserve the target; never substitute the viewer's own relations.
      const result = await this.provider.targetConnections(this.demoAccountId, prior.target.id)
      const people = result.people.slice(0, LIMIT)
      const preview = this.save(state, { ...prior, outcome: result.partial || result.people.length > LIMIT ? 'partial' : people.length ? 'ok' : 'empty', viewedAt: new Date(this.now()).toISOString(), people, note: 'One viewer-visible page; this may be incomplete.' }, generation)
      if (!preview) throw new LabError('conflict', 'Preview was cleared during the request.')
      return preview
    })
  }

  reset(userId: string) {
    const state = this.state(userId)
    state.generation = (state.generation ?? 0) + 1
    delete state.preview
    delete state.previewExpires
  }
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
