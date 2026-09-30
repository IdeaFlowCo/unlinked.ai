import { LabError, type LabProvider, type Profile } from './unipile-lab.ts'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const str = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 500 ? value : undefined

function profile(value: unknown): Profile {
  const row = object(value)
  return {
    id: str(row.provider_id) ?? str(row.id) ?? '',
    name: str(row.name) ?? str(row.full_name) ?? 'Name unavailable',
    headline: str(row.headline),
    publicUrl: str(row.public_profile_url),
  }
}

function page(value: unknown) {
  const body = object(value)
  const items = Array.isArray(body.items) ? body.items : []
  return { people: items.slice(0, 10).map(profile), partial: !!body.cursor || items.length > 10 }
}

export class FixtureUnipileProvider implements LabProvider {
  calls: string[] = []
  private callsOf(name: string) { this.calls.push(name) }
  async hostedLink(input: { name: string }): Promise<string> { this.callsOf('hostedLink'); return `https://example.invalid/fixture?state=${input.name}` }
  async verifyAccount(accountId: string): Promise<void> { this.callsOf('verifyAccount'); if (accountId.startsWith('denied')) throw new LabError('denied', 'Provider denied account access.') }
  async ownProfile(accountId: string): Promise<Profile> { this.callsOf('ownProfile'); return { id: `owner-${accountId}`, name: 'Fixture owner' } }
  async targetProfile(_accountId: string, identifier: string): Promise<Profile> { this.callsOf('targetProfile'); return { id: identifier, name: `Fixture ${identifier}`, publicUrl: `https://www.linkedin.com/in/${identifier}` } }
  async ownConnections(): Promise<{ people: Profile[]; partial: boolean }> { this.callsOf('ownConnections'); return { people: [], partial: false } }
  async targetConnections(): Promise<{ people: Profile[]; partial: boolean }> { this.callsOf('targetConnections'); return { people: [], partial: false } }
}

/** Pinned v1 adapter. It exposes only the six experiment operations. */
export class V1UnipileProvider implements LabProvider {
  private base: string
  private apiKey: string
  constructor(base: string, apiKey: string) {
    this.base = base
    this.apiKey = apiKey
    const url = new URL(base)
    if (url.protocol !== 'https:' || !/^api[a-z0-9-]*\.unipile\.com$/.test(url.hostname) || url.pathname !== '/') {
      throw new LabError('unavailable', 'Unipile API host is invalid.')
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(new URL(path, this.base), {
        ...init,
        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      })
    } catch { throw new LabError('unavailable', 'Provider could not be reached.') }
    if (!response.ok) {
      // Never log or return provider bodies; errors can contain profile details.
      if (response.status === 401 || response.status === 403) throw new LabError('denied', 'Provider denied access or requires a human challenge.')
      if (response.status === 404) throw new LabError('unavailable', 'Provider resource was not found.')
      if (response.status === 400 || response.status === 422 || response.status === 501) throw new LabError('unsupported', 'Provider does not support this request for this account.')
      throw new LabError('unavailable', response.status === 429 ? 'Provider rate limit reached; no automatic retry.' : 'Provider is unavailable.')
    }
    try { return await response.json() } catch { throw new LabError('unavailable', 'Provider response was unreadable.') }
  }

  async hostedLink(input: { name: string; notifyUrl: string; successUrl: string; failureUrl: string; reconnectAccount?: string }): Promise<string> {
    if (process.env.UNLINKED_UNIPILE_SYNC_SCOPE_VERIFIED !== 'true') throw new LabError('unavailable', 'Hosted connection is disabled until provider sync scope is reviewed.')
    const body = {
      type: input.reconnectAccount ? 'reconnect' : 'create',
      providers: ['LINKEDIN'],
      api_url: this.base.replace(/\/$/, ''),
      expiresOn: new Date(Date.now() + 10 * 60_000).toISOString(),
      notify_url: input.notifyUrl,
      success_redirect_url: input.successUrl,
      failure_redirect_url: input.failureUrl,
      name: input.name,
      ...(input.reconnectAccount ? { reconnect_account: input.reconnectAccount } : {}),
    }
    const result = object(await this.request('/api/v1/hosted/accounts/link', { method: 'POST', body: JSON.stringify(body) }))
    const url = str(result.url)
    if (!url || new URL(url).protocol !== 'https:') throw new LabError('unavailable', 'Provider did not return a hosted link.')
    return url
  }

  async verifyAccount(accountId: string): Promise<void> {
    const result = object(await this.request(`/api/v1/accounts/${encodeURIComponent(accountId)}`))
    if (result.id !== accountId || result.type !== 'LINKEDIN') throw new LabError('denied', 'Provider account identity did not match LinkedIn.')
  }
  async ownProfile(accountId: string): Promise<Profile> { return profile(await this.request(`/api/v1/users/me?account_id=${encodeURIComponent(accountId)}`)) }
  async targetProfile(accountId: string, identifier: string): Promise<Profile> { return profile(await this.request(`/api/v1/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`)) }
  async ownConnections(accountId: string) { return page(await this.request(`/api/v1/users/relations?account_id=${encodeURIComponent(accountId)}&limit=10`)) }
  async targetConnections(accountId: string, targetId: string) {
    // v1 own relations are self-only. Classic connections_of is viewer-relative.
    return page(await this.request(`/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}&limit=10`, {
      method: 'POST', body: JSON.stringify({ api: 'classic', category: 'people', connections_of: [targetId] }),
    }))
  }
}

export function configuredProvider(): { provider: LabProvider; demoAccountId?: string; mode: 'fixture' | 'live' } {
  if (process.env.UNLINKED_UNIPILE_TEST_MODE !== 'live') return { provider: new FixtureUnipileProvider(), demoAccountId: 'fixture-demo-account', mode: 'fixture' }
  const base = process.env.UNLINKED_UNIPILE_API_URL
  const key = process.env.UNLINKED_UNIPILE_API_KEY
  const demoAccountId = process.env.UNLINKED_UNIPILE_DEMO_ACCOUNT_ID
  if (!base || !key || !demoAccountId) throw new LabError('unavailable', 'Live provider configuration is incomplete.')
  return { provider: new V1UnipileProvider(base, key), demoAccountId, mode: 'live' }
}
