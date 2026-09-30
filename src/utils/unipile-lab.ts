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
type UserState = { accountId?: string; preview?: Preview; previewExpires?: number; busy?: string }

/** Process-local, expiring test state. Live activation requires a single-instance stage. */
export class UnipileLab {
  private pending = new Map<string, Pending>()
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
    return { connected: !!state.accountId, preview: state.preview }
  }

  private async once<T>(userId: string, action: string, fn: (state: UserState) => Promise<T>): Promise<T> {
    const state = this.state(userId)
    if (state.busy) throw new LabError('conflict', 'A preview request is already running.')
    state.busy = action
    try { return await fn(state) } finally { state.busy = undefined }
  }

  async start(userId: string, origin: string, reconnect = false) {
    return this.once(userId, 'start', async state => {
      if (reconnect && !state.accountId) throw new LabError('invalid', 'No linked account to reconnect.')
      if (!reconnect && state.accountId) throw new LabError('conflict', 'An account is already linked.')
      const name = randomBytes(24).toString('base64url')
      const secret = randomBytes(24).toString('base64url')
      const reconnectAccount = reconnect ? state.accountId : undefined
      const pending: Pending = { userId, secret, expires: this.now() + TTL_MS, reconnectAccount, used: false }
      this.pending.set(name, pending)
      try {
        const url = await this.provider.hostedLink({
          name,
          notifyUrl: `${origin}/api/unipile-lab/callback?state=${name}&token=${secret}`,
          successUrl: `${origin}/unipile-lab?return=success`,
          failureUrl: `${origin}/unipile-lab?return=failure`,
          reconnectAccount,
        })
        return { url }
      } catch (error) { this.pending.delete(name); throw error }
    })
  }

  async callback(input: { state?: unknown; token?: unknown; name?: unknown; status?: unknown; accountId?: unknown }) {
    const pending = typeof input.state === 'string' ? this.pending.get(input.state) : undefined
    if (!pending || pending.used) throw new LabError('denied', 'Unknown or used connection callback.')
    if (this.now() >= pending.expires) { pending.used = true; throw new LabError('expired', 'Connection link expired.') }
    if (typeof input.token !== 'string' || !safeEqual(input.token, pending.secret) || input.name !== input.state) throw new LabError('denied', 'Connection callback did not match its pending request.')
    // Claim before the first await; simultaneous/replayed notifications cannot race.
    pending.used = true
    if (input.status !== (pending.reconnectAccount ? 'RECONNECTED' : 'CREATION_SUCCESS')) throw new LabError('denied', 'Connection was not confirmed by the provider.')
    if (typeof input.accountId !== 'string' || !/^[a-zA-Z0-9_-]{4,100}$/.test(input.accountId)) throw new LabError('invalid', 'Invalid provider account.')
    const state = this.state(pending.userId)
    if (pending.reconnectAccount && (input.accountId !== pending.reconnectAccount || state.accountId !== pending.reconnectAccount)) throw new LabError('denied', 'Reconnect account does not belong to this tester.')
    if (!pending.reconnectAccount && (state.accountId || this.accountOwners.has(input.accountId) || input.accountId === this.demoAccountId)) throw new LabError('denied', 'Provider account is already assigned.')
    await this.provider.verifyAccount(input.accountId)
    const own = await this.provider.ownProfile(input.accountId)
    if (!own.id) throw new LabError('unavailable', 'Provider did not verify the account owner.')
    state.accountId = input.accountId
    this.accountOwners.set(input.accountId, pending.userId)
    this.save(state, { outcome: 'ok', viewedAt: new Date(this.now()).toISOString(), mode: 'own', target: own })
  }

  private save(state: UserState, preview: Preview): Preview {
    state.preview = preview
    state.previewExpires = this.now() + TTL_MS
    return preview
  }

  async ownConnections(userId: string): Promise<Preview> {
    return this.once(userId, 'ownConnections', async state => {
      if (!state.accountId) throw new LabError('denied', 'Connect your own LinkedIn first.')
      if (state.preview?.mode === 'own' && state.preview.people) return state.preview
      const result = await this.provider.ownConnections(state.accountId)
      const people = result.people.slice(0, LIMIT)
      return this.save(state, { outcome: result.partial || result.people.length > LIMIT ? 'partial' : people.length ? 'ok' : 'empty', viewedAt: new Date(this.now()).toISOString(), mode: 'own', people })
    })
  }

  async previewTarget(userId: string, rawUrl: unknown): Promise<Preview> {
    return this.once(userId, 'target', async state => {
      const identifier = parseLinkedInUrl(rawUrl)
      if (!this.demoAccountId) throw new LabError('unavailable', 'Demo account is not configured.')
      if (this.allowedTargets && !this.allowedTargets.has(identifier)) throw new LabError('denied', 'This target is not approved for the live test.')
      if (state.preview?.mode === 'demo' && state.preview.target?.publicUrl === `https://www.linkedin.com/in/${identifier}`) return state.preview
      const target = await this.provider.targetProfile(this.demoAccountId, identifier)
      if (!target.id) throw new LabError('unavailable', 'Target profile has no usable provider ID.')
      return this.save(state, { outcome: 'ok', viewedAt: new Date(this.now()).toISOString(), mode: 'demo', target: { ...target, publicUrl: `https://www.linkedin.com/in/${identifier}` } })
    })
  }

  async targetConnections(userId: string): Promise<Preview> {
    return this.once(userId, 'targetConnections', async state => {
      if (!this.demoAccountId) throw new LabError('unavailable', 'Demo account is not configured.')
      const prior = state.preview
      if (!prior || prior.mode !== 'demo' || !prior.target?.id) throw new LabError('invalid', 'Preview a target profile first.')
      if (prior.people) return prior
      // Preserve the target; never substitute the viewer's own relations.
      const result = await this.provider.targetConnections(this.demoAccountId, prior.target.id)
      const people = result.people.slice(0, LIMIT)
      return this.save(state, { ...prior, outcome: result.partial || result.people.length > LIMIT ? 'partial' : people.length ? 'ok' : 'empty', viewedAt: new Date(this.now()).toISOString(), people, note: 'One viewer-visible page; this may be incomplete.' })
    })
  }

  reset(userId: string) {
    const state = this.state(userId)
    delete state.preview
    delete state.previewExpires
  }
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
