import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createPrivateBrowserHandler } from '../../mcp-server/private-browser.mjs'
import { createAccountGrantService } from '../../mcp-server/account-grants.mjs'

export async function manualKeyFixture({ connectorPreview = false } = {}) {
  const owner = { ownerId: 'synthetic-key-owner', userId: 'synthetic-key-user' }
  const foreign = { ownerId: 'synthetic-other-owner', userId: 'synthetic-other-user' }
  const resources = new Map(), audits = []
  let failWrite = false, beforeWrite = null
  const getBackend = async caller => ({
    readResource: async (_type, id) => { const row = resources.get(id); return row?.sourceOwnerId === caller.ownerId ? structuredClone(row) : null },
    writeResource: async row => {
      if (failWrite) throw new Error('synthetic_write_failure')
      if (beforeWrite) { const fn = beforeWrite; beforeWrite = null; await fn() }
      const prior = resources.get(row.sourceId)
      if (row.sourceOwnerId !== caller.ownerId || (prior ? prior.deleted || prior.sourceRevision !== row.expectedRevision : row.expectedRevision !== null)) throw new Error('cas_conflict')
      resources.set(row.sourceId, structuredClone(row))
    },
    listAccountGrantIds: async () => [...resources.values()].filter(row => row.sourceOwnerId === caller.ownerId && !row.deleted && row.payload?.kind === 'account_tool_grant').map(row => row.sourceId),
    listImportIds: async () => [], listImportJobIds: async () => [], adapter: {},
  })
  const options = { issuer: 'https://synthetic-keys.invalid', signingKey: randomBytes(32), getBackend, publicSearchEnabled: true }
  const grants = createAccountGrantService(options)
  let handler
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = endpoint.replace('http:', 'https:')
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    ...(connectorPreview ? { oauth: { readAuthorization: async () => { throw Error('synthetic_preview_only') }, approve: () => {}, deny: () => {} } } : {}),
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }), finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'synthetic-key-subject' }) },
    resolveOwner: async () => owner, signup: async () => owner, getBackend,
    issueAccountGrant: grants.issueGrant, ensureAccountGrant: grants.ensureGrant, revokeAccountGrant: grants.revoke,
    listAccountGrants: grants.listGrants, accountKeys: grants, mcpEndpoint: `${baseUrl}/mcp`,
    readPublishedSnapshot: async () => ({ state: 'published', complete: true, revision: 'synthetic-keys', profiles: [], connections: [] }),
    audit: async row => audits.push(row),
  })
  const signIn = async () => {
    const start = await fetch(`${endpoint}/login`, { redirect: 'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=x`, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } })
    const cookie = callback.headers.getSetCookie().find(row => row.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(`${endpoint}/settings`, { headers: { Cookie: cookie } })).text()
    return { cookie, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] }
  }
  const post = (session, input, extra = {}) => fetch(`${endpoint}/settings/api-keys`, { method: 'POST', redirect: 'manual', headers: { Cookie: session.cookie, Origin: baseUrl, ...extra }, body: new URLSearchParams({ csrf: session.csrf, ...input }) })
  const page = async (session, id) => fetch(`${endpoint}/settings${id ? `?key=${id}` : ''}`, { headers: { Cookie: session.cookie } })
  return { owner, foreign, resources, audits, grants, options, endpoint, baseUrl, signIn, post, page, close: () => new Promise(resolve => server.close(resolve)),
    failWrites: value => { failWrite = value }, beforeWrite: fn => { beforeWrite = fn } }
}
