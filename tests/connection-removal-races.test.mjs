import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnectionActions } from '../mcp-server/connection-actions.mjs'
import { createConnectionRequests, createMemoryConnectionStore, createNeo4jConnectionStore, pairKey } from '../mcp-server/member-connections.mjs'
import { createMemberInvitations, createMemoryInvitationStore, createNeo4jInvitationStore } from '../mcp-server/member-invitations.mjs'

const endpoint = process.env.UNLINKED_CONNECTION_TEST_HTTP
if (endpoint) {
  assert.equal(process.env.UNLINKED_CONNECTION_TEST_DISPOSABLE, '1', 'Neo4j integration requires an explicit disposable database')
  assert.equal(new URL(endpoint).hostname, '127.0.0.1')
  assert.ok(new URL(endpoint).port)
}
const a = { ownerId: 'removal-a', userId: 'removal-a' }
const b = { ownerId: 'removal-b', userId: 'removal-b' }
const c = { ownerId: 'removal-c', userId: 'removal-c' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function httpDriver(url) {
  async function request(path, query, parameters = {}) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statements: query ? [{ statement: query, parameters }] : [] }) })
    const body = await response.json()
    if (body.errors?.length) throw Object.assign(new Error(body.errors[0].message), { code: body.errors[0].code })
    assert.ok(response.ok, `Neo4j HTTP ${response.status}`)
    const result = body.results?.[0]
    return { location: response.headers.get('location'), records: (result?.data ?? []).map(({ row }) => ({ get: name => row[result.columns.indexOf(name)] })) }
  }
  const run = (query, params) => request('/db/neo4j/tx/commit', query, params)
  return { run, request, session: () => ({ close: async () => {}, executeRead: work => work({ run }), executeWrite: work => work({ run }) }) }
}

async function fixture(kind) {
  const driver = kind === 'neo4j' ? httpDriver(endpoint) : null
  if (driver) await driver.run(`MATCH (n) WHERE (n:UnlinkedConnectionRequest AND n.senderOwnerId IN $owners) OR (n:UnlinkedMemberInvitation AND n.inviterOwnerId IN $owners) DETACH DELETE n`, { owners: [a.ownerId, b.ownerId, c.ownerId] })
  const store = driver ? createNeo4jConnectionStore(driver) : createMemoryConnectionStore()
  const invitationStore = driver ? createNeo4jInvitationStore(driver) : createMemoryInvitationStore()
  if (driver) { await store.initialize(); await invitationStore.initialize() }
  const retracted = []
  const requests = createConnectionRequests({ store, perDay: 10000, notifications: {
    notify: async () => {}, markReadByKey: async () => {}, retract: async key => retracted.push(key),
  } })
  const invites = createMemberInvitations({ store: invitationStore })
  const actions = createConnectionActions({ memberConnections: requests, memberInvitations: invites, accountForProfile: async id => ({ a, b, c })[id] })
  async function invitation(inviter = a, invitee = b) {
    const link = await invites.create({ inviter, inviterName: 'Member', inviteeName: 'Other' })
    await invites.respond(link.token, invitee, 'accept', 'Other')
    return link
  }
  async function agreement(selectedKind) {
    if (selectedKind === 'invite') return `invite:${(await invitation()).invitation.id}`
    const sent = await requests.send({ sender: a, recipient: b })
    await requests.respond(b, sent.request.id, 'accept')
    return sent.request.id
  }
  return { driver, store, invitationStore, requests, invites, actions, retracted, invitation, agreement }
}

for (const backend of ['memory', 'neo4j']) {
  test(`${backend}: exact agreement claims and captured settlement preserve reconnections`, { skip: backend === 'neo4j' && !endpoint }, async t => {
    for (const selectedKind of ['request', 'invite']) for (const remover of [a, b]) for (const freshStatus of ['pending', 'accepted']) {
      await t.test(`delayed duplicate ${selectedKind}, ${remover === a ? 'sender' : 'recipient'}, fresh ${freshStatus}`, async () => {
        const f = await fixture(backend), selected = await f.agreement(selectedKind)
        const reached = deferred(), resume = deferred()
        const claimStore = selectedKind === 'request' ? f.store : f.invitationStore
        const transition = claimStore.transition.bind(claimStore)
        let delay = true
        claimStore.transition = async (...args) => {
          const accepted = selectedKind === 'request' ? args[1].includes('accepted') : args[1] === 'accepted'
          if (accepted && delay) { delay = false; reached.resolve(); await resume.promise }
          return transition(...args)
        }
        const delayed = f.actions.remove(remover, selected)
        const rejected = assert.rejects(delayed, { code: 'connection_unavailable' })
        await reached.promise
        try {
          await f.actions.remove(remover === a ? b : a, selected)
          const fresh = await f.requests.send({ sender: b, recipient: a })
          if (freshStatus === 'accepted') await f.requests.respond(a, fresh.request.id, 'accept')
          const link = await f.invitation(b, a)
          resume.resolve(); await rejected
          assert.equal((await f.store.get(fresh.request.id)).status, freshStatus)
          assert.equal((await f.invites.open(link.token)).status, 'accepted')
          assert.equal((await f.requests.between(a, b)).state, freshStatus === 'accepted' ? 'connected' : 'incoming')
        } finally { resume.resolve() }
      })
      await t.test(`delayed settlement ${selectedKind}, ${remover === a ? 'sender' : 'recipient'}, fresh ${freshStatus}`, async () => {
        const f = await fixture(backend), selected = await f.agreement(selectedKind)
        const reached = deferred(), resume = deferred(), settle = f.requests.settleRemovedPair.bind(f.requests)
        f.requests.settleRemovedPair = async (...args) => { reached.resolve(); await resume.promise; return settle(...args) }
        const removing = f.actions.remove(remover, selected)
        await reached.promise
        try {
          const fresh = await f.requests.send({ sender: a, recipient: b })
          if (freshStatus === 'accepted') await f.requests.respond(b, fresh.request.id, 'accept')
          const link = await f.invitation(b, a)
          resume.resolve(); await removing
          assert.equal((await f.store.get(fresh.request.id)).status, freshStatus)
          assert.equal((await f.invites.open(link.token)).status, 'accepted')
          assert.ok(!f.retracted.includes(`connection-request:${fresh.request.id}`))
        } finally { resume.resolve() }
      })
    }
    for (const status of ['pending', 'ignored']) for (const remover of [a, b]) {
      await t.test(`obsolete ${status} is settled and retracted by ${remover === a ? 'sender' : 'recipient'}`, async () => {
        const f = await fixture(backend), old = await f.requests.send({ sender: a, recipient: b })
        if (status === 'ignored') await f.requests.respond(b, old.request.id, 'ignore')
        const selected = await f.agreement('invite')
        await assert.rejects(f.actions.remove(c, selected), { code: 'connection_not_found' })
        assert.equal((await f.store.get(old.request.id)).status, status)
        await f.actions.remove(remover, selected)
        assert.equal((await f.store.get(old.request.id)).status, 'removed')
        assert.deepEqual(f.retracted, [`connection-request:${old.request.id}`])
        assert.equal(await f.requests.pendingCount(b), 0)
        const fresh = await f.requests.send({ sender: remover, recipient: remover === a ? b : a })
        assert.notEqual(fresh.request.id, old.request.id)
        assert.equal(fresh.status, 'pending')
      })
    }
  })

  test(`${backend}: active pair state and withdrawal cooldown survive over 500 inactive records`, { skip: backend === 'neo4j' && !endpoint }, async t => {
    for (const status of ['pending', 'ignored', 'accepted', 'withdrawn']) await t.test(status, async () => {
      const f = await fixture(backend), pair = pairKey(a, b)
      const base = { pairKey: pair, senderOwnerId: a.ownerId, senderUserId: a.userId, recipientOwnerId: b.ownerId, recipientUserId: b.userId, createdAt: 1 }
      const records = Array.from({ length: 601 }, () => ({ ...base, id: randomUUID(), status: 'removed' }))
      records.push({ ...base, id: randomUUID(), status: 'withdrawn', withdrawnAt: 1 })
      if (f.driver) await f.driver.run('UNWIND $records AS record CREATE (r:UnlinkedConnectionRequest) SET r = record', { records })
      else for (const record of records) await f.store.insert(record)
      const sent = await f.requests.send({ sender: a, recipient: b })
      if (status === 'accepted') await f.requests.respond(b, sent.request.id, 'accept')
      if (status === 'ignored') await f.requests.respond(b, sent.request.id, 'ignore')
      if (status === 'withdrawn') await f.requests.withdraw(a, sent.request.id)
      const relevant = await f.store.listPair(pair)
      assert.ok(relevant.some(record => record.id === sent.request.id))
      assert.ok(relevant.every(record => record.status !== 'removed'))
      assert.equal(relevant.filter(record => record.status === 'withdrawn').length, 1)
      if (status === 'accepted') {
        assert.equal((await f.requests.between(a, b)).state, 'connected')
        await assert.rejects(f.requests.send({ sender: a, recipient: b }), { code: 'connection_exists' })
        await f.actions.remove(b, sent.request.id)
        assert.equal((await f.requests.between(a, b)).state, 'none')
      } else if (status === 'withdrawn') {
        await assert.rejects(f.requests.send({ sender: a, recipient: b }), { code: 'connection_cooldown' })
      } else {
        assert.equal((await f.requests.between(a, b)).state, 'outgoing')
        await assert.rejects(f.requests.send({ sender: a, recipient: b }), { code: 'connection_pending' })
        assert.equal((await f.requests.send({ sender: b, recipient: a })).status, 'accepted')
      }
    })
  })
}

test('neo4j: accepted-state checks run after acquiring the selected record lock', { skip: !endpoint }, async t => {
  for (const selectedKind of ['request', 'invite']) await t.test(selectedKind, async () => {
    const f = await fixture('neo4j'), selected = await f.agreement(selectedKind)
    const inviteRecord = selectedKind === 'invite' ? (await f.invitationStore.listAccepted(a))[0] : null
    const match = selectedKind === 'request' ? 'MATCH (r:UnlinkedConnectionRequest {id: $id})' : 'MATCH (r:UnlinkedMemberInvitation {id: $id})'
    const id = selected.replace(/^invite:/, '')
    const locked = await f.driver.request('/db/neo4j/tx', `${match} SET r._testLock = true RETURN r.id`, { id })
    const transaction = new URL(locked.location).pathname
    let changed
    try {
      const transition = selectedKind === 'request'
        ? f.store.transition(id, ['accepted'], { status: 'removed' }, ['connectedKey'])
        : f.invitationStore.transition(inviteRecord.tokenHash, 'accepted', { status: 'revoked' }, null)
      const deadline = Date.now() + 10000
      while (true) {
        const result = await f.driver.run('SHOW TRANSACTIONS YIELD status RETURN status')
        if (result.records.some(record => String(record.get('status')).startsWith('Blocked'))) break
        assert.ok(Date.now() < deadline, 'contender must wait for selected agreement lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await f.driver.request(`${transaction}/commit`, `${match} SET r.status = $status REMOVE r.connectedKey RETURN r.id`, { id, status: selectedKind === 'request' ? 'removed' : 'revoked' })
      changed = await transition
    } finally {
      await fetch(`${endpoint}${transaction}`, { method: 'DELETE' })
    }
    assert.equal(changed, false)
  })
})
