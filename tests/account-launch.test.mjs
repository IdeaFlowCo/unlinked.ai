import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { createAccountGrantService } from '../mcp-server/account-grants.mjs'
import { createAccountHostedHandler } from '../mcp-server/account-hosted.mjs'
import { createAccountNetwork } from '../src/utils/private-import/account-network.mjs'
import { parseArchive, LIMITS, digest } from '../src/utils/private-import/archive.mjs'
import { privateId } from '../src/utils/private-import/job.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
const require = createRequire(new URL('../mcp-server/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const header = 'First Name,Last Name,URL,Company,Position\n'

test('full archive above former20MiB retains original bytes and indexes selected five CSV categories without inflating media', async () => {
  const zip = new JSZip()
  zip.file('Connections.csv', header + 'Synthetic,Connection,https://www.linkedin.com/in/synthetic-full,Example,Engineer\n')
  zip.file('Profile.csv', 'First Name,Last Name\nSynthetic,Member\n')
  zip.file('Positions.csv', 'Company Name,Title\nExample,Engineer\n')
  zip.file('Education.csv', 'School Name\nSynthetic University\n')
  zip.file('Skills.csv', 'Name\nGraph design\n')
  const media = randomBytes(21 * 1024 * 1024)
  zip.file('media/video.bin', media)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  assert.ok(bytes.length > 20 * 1024 * 1024 && bytes.length < LIMITS.archiveBytes)
  const parsed = parseArchive(bytes, 'complete-export.zip')
  assert.equal(parsed.archiveSha256, digest(bytes))
  assert.equal(parsed.sources.reduce((n, x) => n + x.accepted.length, 0), 5)
  assert.deepEqual(parsed.sources.filter(x => !x.skipped).map(x => x.category), ['connections', 'profile', 'positions', 'education', 'skills'])
  const manifest = parsed.sources.find(x => x.skipped)
  assert.equal(manifest.skippedFileCount, 1)
  assert.equal(JSON.parse(manifest.rawBytes).entries[0].expandedBytes, media.length)
  assert.equal(JSON.parse(manifest.rawBytes).entries[0].compressedSha256, digest(media))
  assert.ok(manifest.rawBytes.length < 1024)
  assert.deepEqual(await (await JSZip.loadAsync(bytes)).file('media/video.bin').async('nodebuffer'), media)
})

function fixture() {
  const owners = new Map(), resources = new Map(), assets = new Map()
  const key = x => JSON.stringify([x.ownerId, x.userId])
  const register = owner => owners.set(key(owner), owner)
  const getBackend = async owner => {
    if (!owners.has(key(owner))) throw new Error('owner_denied')
    const own = () => [...resources.values()].filter(x => x.sourceOwnerId === owner.ownerId && !x.deleted)
    const readResource = async (_type, id) => {
      const value = resources.get(id)
      return value?.sourceOwnerId === owner.ownerId ? structuredClone(value) : null
    }
    const writeResource = async value => {
      assert.equal(value.sourceOwnerId, owner.ownerId)
      const prior = resources.get(value.sourceId)
      if (prior && (prior.sourceOwnerId !== owner.ownerId || prior.deleted || prior.sourceRevision !== value.expectedRevision)) throw new Error('cas_conflict')
      resources.set(value.sourceId, structuredClone(value))
    }
    return { readResource, writeResource,
      listImportIds: async () => own().filter(x => x.payload?.id === x.sourceId && !x.payload?.kind && !x.payload?.receiptOf && ['indexed','partial'].includes(x.payload.status)).map(x => x.sourceId).sort(),
      listAccountGrantIds: async () => own().filter(x => x.payload?.kind === 'account_tool_grant').map(x => x.sourceId).sort(),
      adapter: { withImport: async (caller, id, work) => {
        assert.equal(caller, owner.ownerId)
        return work({ getJob: async () => (await readResource('import', id))?.payload,
          putAsset: async (hash, bytes) => assets.set(privateId(owner.ownerId, hash), Buffer.from(bytes)),
          publicationStatus: 'indexed',
          saveJob: async job => resources.set(id, { sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, payload: structuredClone(job) }),
          publish: async (job, assertions) => {
            job.assertionIds = assertions.map(x => x.id)
            resources.set(id, { sourceId: id, sourceOwnerId: owner.ownerId, sourceRevision: job.revision, payload: structuredClone(job) })
            for (const row of assertions) resources.set(row.id, { sourceId: row.id, sourceOwnerId: owner.ownerId, payload: row })
          },
        })
      } },
    }
  }
  return { register, getBackend, resources, assets }
}

test('open browser signup →1001 ConnectionsZIP→whole-owner search→durable account MCP→revoke, with returning import discovery and cross-owner denial', async t => {
  const f = fixture(), bindings = new Map(), seen = new Set(), owner = { ownerId: 'synthetic-open-owner', userId: 'synthetic-open-user' }
  const signingKey = randomBytes(32), grants = createAccountGrantService({ issuer: 'https://synthetic-private.invalid', signingKey, getBackend: f.getBackend })
  let handler, mcp, signupCalls = 0
  const server = createServer((req,res) => void (req.url === '/mcp' ? mcp(req,res) : handler(req,res)))
  await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => new Promise(r => server.close(r)))
  const endpoint = `http://127.0.0.1:${server.address().port}`, baseUrl = `https://127.0.0.1:${server.address().port}`
  const complete = async ({ input, candidateIds }) => {
    for (const id of candidateIds) seen.add(id)
    const rows = JSON.parse(input).observations
    return { matches: rows.filter(x => x.fields.company === 'Zephyr').map(x => ({ id: x.id, reason: 'Observed Zephyr engineer' })).slice(0,10) }
  }
  handler = createPrivateBrowserHandler({ baseUrl, dataMode: 'synthetic',
    login: { begin: async () => ({ location: 'https://synthetic-idp.invalid/authorize', transaction: { state: 'synthetic-state' } }),
      finish: async () => ({ issuer: 'https://synthetic-idp.invalid', subject: 'exact-opaque-subject', clientId: 'synthetic-client', verifiedAt: Math.floor(Date.now()/1000), provenanceReceiptId: 'synthetic-callback-proof' }) },
    resolveOwner: async identity => bindings.get(`${identity.issuer}:${identity.subject}`),
    signup: async identity => { signupCalls++; assert.equal(identity.subject, 'exact-opaque-subject'); assert.equal(Object.hasOwn(identity,'email'),false); bindings.set(`${identity.issuer}:${identity.subject}`,owner); f.register(owner); return owner },
    getBackend: f.getBackend, complete, issueAccountGrant: grants.issueGrant, revokeAccountGrant: grants.revoke, mcpEndpoint: `${baseUrl}/mcp`,
  })
  mcp = createAccountHostedHandler({ authenticateGrant: grants.authenticateGrant, getBackend: f.getBackend, complete, origin: baseUrl })
  const signIn = async () => {
    const start = await fetch(`${endpoint}/login`, { redirect:'manual' })
    const callback = await fetch(`${endpoint}/auth/callback/ideaflow?state=synthetic-state&code=synthetic`, { redirect:'manual', headers:{ Cookie:start.headers.getSetCookie()[0].split(';')[0] } })
    assert.equal(callback.status,303)
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('__Host-ul-session=')).split(';')[0]
    const page = await (await fetch(endpoint,{headers:{Cookie:cookie}})).text()
    return { cookie,csrf:page.match(/name="csrf" value="([^"]+)"/)[1],page }
  }
  const signed = await signIn(); assert.equal(signupCalls,1)
  const zip = new JSZip(), csv = header + Array.from({length:1001},(_,i) => `Synthetic${i},Contact,https://www.linkedin.com/in/synthetic-open-${i},${i===1000?'Zephyr':'Example'},Engineer\n`).join('')
  zip.file('Connections.csv',csv)
  const bytes = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
  const upload = async (value,name) => {
    const form=new FormData();form.set('csrf',signed.csrf);form.set('consent','yes');form.set('syntheticConsent','yes');form.set('archive',new Blob([value]),name)
    return fetch(`${endpoint}/upload`,{method:'POST',redirect:'manual',headers:{Cookie:signed.cookie,Origin:baseUrl},body:form})
  }
  const imported=await upload(bytes,'Connections-only.zip');assert.equal(imported.status,303)
  const id=imported.headers.get('location').split('/').pop(),job=f.resources.get(id).payload
  assert.equal(job.counts.accepted,1001);assert.equal(job.counts.indexed,1001)
  assert.equal((await upload(bytes,'Connections-only.zip')).headers.get('location'),imported.headers.get('location'))
  const second=await upload(Buffer.from(header+'Second,Import,https://www.linkedin.com/in/synthetic-second,Other,Designer\n'),'Connections.csv');assert.equal(second.status,303)
  const returned=await signIn();assert.equal(signupCalls,1);assert.ok(returned.page.includes('Connections-only.zip'))
  const post=(path,input)=>fetch(endpoint+path,{method:'POST',redirect:'manual',headers:{Cookie:signed.cookie,Origin:baseUrl},body:new URLSearchParams({csrf:signed.csrf,...input})})
  const searched=await post('/search-account',{query:'Zephyr engineer'});assert.equal(searched.status,200);assert.match(await searched.text(),/Synthetic1000 Contact/);assert.equal(seen.size,1002)
  const setup=await post('/setup-account',{});assert.equal(setup.status,200)
  const setupHtml=await setup.text(),encoded=setupHtml.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1]
  const config=JSON.parse(encoded.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'))
  const authorization=config.mcpServers['unlinked-private'].headers.Authorization
  assert.ok(!Object.hasOwn(JSON.parse(Buffer.from(authorization.split('.')[1],'base64url')),'exp'))
  const restarted=createAccountGrantService({issuer:'https://synthetic-private.invalid',signingKey,getBackend:f.getBackend})
  assert.ok(await restarted.authenticateGrant({headers:{authorization}}))
  const grant=await grants.authenticateGrant({headers:{authorization}})
  const client=new Client({name:'synthetic-account-proof',version:'1.0'})
  const transport=new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`),{requestInit:{headers:{Authorization:authorization}}})
  try {
    await client.connect(transport)
    assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['unlinked_search_network'])
    const result=await client.callTool({name:'unlinked_search_network',arguments:{query:'Zephyr'}})
    assert.ok(!result.isError);const data=JSON.parse(result.content[0].text);assert.equal(data.indexed,1002);assert.equal(data.considered,1002);assert.equal(data.scope,'owner_network')
    const foreign={ownerId:'other-owner',userId:'other-user'};f.register(foreign)
    assert.equal(await (await f.getBackend(foreign)).readResource('import',id),null)
    await assert.rejects(grants.revoke(foreign,grant.grantId),/not_found/)
    const revoked=await post('/revoke-account',{grantId:grant.grantId});assert.equal(revoked.status,303)
    assert.equal(await grants.authenticateGrant({headers:{authorization}}),null)
    await assert.rejects(client.callTool({name:'unlinked_search_network',arguments:{query:'Zephyr'}}))
  } finally { await client.close() }
  const publication=f.resources.get(id);publication.deleted=true
  await assert.rejects(createAccountNetwork({owner,getBackend:async binding=>({...await f.getBackend(binding),listImportIds:async()=>[id]}),complete}).search({query:'Zephyr'}),/not_found/)
})

test('account network rejects an oversized next import before reading its rows or assets', async () => {
  const owner = { ownerId: 'budget-owner', userId: 'budget-user' }
  const firstImport = '1'.repeat(64), secondImport = '2'.repeat(64), firstRow = '3'.repeat(64)
  const secondRows = ['4'.repeat(64), '5'.repeat(64)]
  let secondRowReads = 0, assetReads = 0
  const importResource = (id, assertionIds) => ({ sourceOwnerId: owner.ownerId, sourceRevision: 1, deleted: false,
    payload: { id, status: 'indexed', assertionIds, counts: { accepted: assertionIds.length, indexed: assertionIds.length, rejected: 0, skippedFiles: 0, failedFiles: 0 }, consent: COMBINED_UPLOAD_CONSENT } })
  const resources = new Map([
    [firstImport, importResource(firstImport, [firstRow])],
    [secondImport, importResource(secondImport, secondRows)],
    [firstRow, { sourceOwnerId: owner.ownerId, deleted: false, payload: { id: firstRow, ownerId: owner.ownerId, importId: firstImport, sourceId: firstImport, rowId: 'Connections.csv#record=2', category: 'connections', fields: { company: 'One' } } }],
  ])
  const readResource = async (type, id) => {
    if (type === 'assertion' && secondRows.includes(id)) secondRowReads++
    return resources.get(id) ?? null
  }
  const network = createAccountNetwork({ owner, observationLimit: 1, getBackend: async () => ({
    listImportIds: async () => [firstImport, secondImport],
    readResource,
    readAsset: async () => { assetReads++; return Buffer.from('{}') },
  }) })
  await assert.rejects(network.readNetwork(), /account_observation_limit/)
  assert.equal(secondRowReads, 0)
  assert.equal(assetReads, 0)
})
