import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnectionActions } from '../mcp-server/connection-actions.mjs'
import { createConnectionRequests, createMemoryConnectionStore, createNeo4jConnectionStore, pairKey } from '../mcp-server/member-connections.mjs'
import { createNotifications, createMemoryNotificationStore, createNeo4jNotificationStore } from '../mcp-server/member-notifications.mjs'
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
  if (driver) await driver.run(`MATCH (n) WHERE (n:UnlinkedConnectionRequest AND n.senderOwnerId IN $owners) OR (n:UnlinkedMemberInvitation AND n.inviterOwnerId IN $owners) OR (n:UnlinkedNotification AND (n.recipientOwnerId IN $owners OR n.actorOwnerId IN $owners)) DETACH DELETE n`, { owners: [a.ownerId, b.ownerId, c.ownerId] })
  const store = driver ? createNeo4jConnectionStore(driver) : createMemoryConnectionStore()
  const invitationStore = driver ? createNeo4jInvitationStore(driver) : createMemoryInvitationStore()
  if (driver) { await store.initialize(); await invitationStore.initialize() }
  const notificationStore = driver ? createNeo4jNotificationStore(driver) : createMemoryNotificationStore()
  if (driver) await notificationStore.initialize()
  const notifications = createNotifications({ store: notificationStore })
  const retracted = [], retract = notifications.retract.bind(notifications)
  notifications.retract = async (...args) => { retracted.push(args[0]); await retract(...args) }
  const requests = createConnectionRequests({ store, perDay: 10000, notifications })
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
  return { driver, store, invitationStore, notificationStore, notifications, requests, invites, actions, retracted, invitation, agreement }
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

for (const backend of ['memory', 'neo4j']) {
  test(`${backend}: durable removal retries recover captured settlement failures`, { skip: backend === 'neo4j' && !endpoint }, async t => {
    for (const selectedKind of ['request', 'invite']) for (const remover of [a, b]) {
      for (const failure of ['claim_after', 'request_before', 'request_after', 'invite_before', 'invite_after', 'retract_before', 'retract_after']) for (const freshStatus of ['pending', 'accepted']) {
        await t.test(`${selectedKind}, ${remover === a ? 'sender' : 'recipient'}, ${failure}, fresh ${freshStatus}`, async () => {
          const f = await fixture(backend), selected = await f.agreement(selectedKind)
          const obsolete = { id: randomUUID(), pairKey: pairKey(a, b), openKey: pairKey(a, b), status: 'pending', createdAt: 1,
            senderOwnerId: a.ownerId, senderUserId: a.userId, recipientOwnerId: b.ownerId, recipientUserId: b.userId }
          await f.store.insert(obsolete)
          const extra = await f.invitation()
          const selectedInvitation = selectedKind === 'invite' ? (await f.invitationStore.listAccepted(a)).find(value => `invite:${value.id}` === selected) : null
          const extraRecord = (await f.invitationStore.listAccepted(a)).find(value => value.id === extra.invitation.id)
          const requestTransition = f.store.transition.bind(f.store), inviteTransition = f.invitationStore.transition.bind(f.invitationStore), get = f.store.get.bind(f.store)
          const deleteByKey = f.notificationStore.deleteByKey.bind(f.notificationStore)
          let injected = false
          const fault = () => { injected = true; throw new Error('injected_store_failure') }
          f.store.get = async id => { if (!injected && failure === 'request_before' && id === obsolete.id) fault(); return get(id) }
          f.store.transition = async (...args) => {
            const result = await requestTransition(...args)
            if (!injected && result && ((failure === 'claim_after' && selectedKind === 'request' && args[0] === selected) || (failure === 'request_after' && args[0] === obsolete.id))) fault()
            return result
          }
          f.invitationStore.transition = async (...args) => {
            const settling = args[0] === extraRecord.tokenHash
            if (!injected && settling && failure === 'invite_before') fault()
            const result = await inviteTransition(...args)
            if (!injected && result && ((failure === 'claim_after' && selectedKind === 'invite' && args[0] === selectedInvitation.tokenHash) || (settling && failure === 'invite_after'))) fault()
            return result
          }
          f.notificationStore.deleteByKey = async (...args) => {
            const obsoleteKey = args[0] === `connection-request:${obsolete.id}`
            if (!injected && obsoleteKey && failure === 'retract_before') fault()
            const result = await deleteByKey(...args)
            if (!injected && obsoleteKey && failure === 'retract_after') fault()
            return result
          }
          await assert.rejects(f.actions.remove(remover, selected), /injected_store_failure/)
          assert.equal(injected, true)
          f.store.get = get; f.store.transition = requestTransition; f.invitationStore.transition = inviteTransition; f.notificationStore.deleteByKey = deleteByKey
          await f.requests.settleRemovedPair(remover, remover === a ? b : a, [obsolete.id])
          const fresh = await f.requests.send({ sender: a, recipient: b })
          if (freshStatus === 'accepted') await f.requests.respond(b, fresh.request.id, 'accept')
          const newInvite = await f.invitation(b, a)
          const restarted = createConnectionActions({
            memberConnections: createConnectionRequests({ store: f.store, notifications: f.notifications }),
            memberInvitations: createMemberInvitations({ store: f.invitationStore }), accountForProfile: async id => ({ a, b, c })[id],
          })
          await assert.rejects(restarted.remove(c, selected), { code: 'connection_not_found' })
          await restarted.remove(freshStatus === 'pending' ? remover : remover === a ? b : a, selected)
          assert.equal((await f.store.get(obsolete.id)).status, 'removed')
          assert.equal((await f.invites.open(extra.token)).status, 'revoked')
          assert.equal(await f.notifications.notify({ recipient: b, actor: a, kind: 'connection_request_received', dedupeKey: `connection-request:${obsolete.id}` }), false)
          assert.equal((await f.store.get(fresh.request.id)).status, freshStatus)
          assert.equal((await f.invites.open(newInvite.token)).status, 'accepted')
          await assert.rejects(restarted.remove(remover, selected), { code: 'connection_not_found' })
          assert.equal((await f.store.get(fresh.request.id)).status, freshStatus)
        })
      }
    }
  })

  test(`${backend}: retraction wins delayed request notification insertion`, { skip: backend === 'neo4j' && !endpoint }, async t => {
    for (const action of ['withdraw', 'remove']) for (const remover of action === 'withdraw' ? [a] : [a, b]) await t.test(`${action}, ${remover === a ? 'sender' : 'recipient'}`, async () => {
      const f = await fixture(backend), reached = deferred(), resume = deferred(), insert = f.notificationStore.insertOnce.bind(f.notificationStore)
      f.notificationStore.insertOnce = async record => { reached.resolve(); await resume.promise; return insert(record) }
      const sending = f.requests.send({ sender: a, recipient: b })
      await reached.promise
      const pending = (await f.store.listPair(pairKey(a, b))).find(record => record.status === 'pending')
      try {
        if (action === 'withdraw') await f.requests.withdraw(a, pending.id)
        else await f.actions.remove(remover, await f.agreement('invite'))
        resume.resolve(); await sending
        assert.deepEqual(await f.notifications.list(b), [])
        assert.deepEqual(await f.notifications.counts(b), { unseen: 0, unread: 0 })
        assert.equal(await f.notifications.notify({ recipient: b, actor: a, kind: 'connection_request_received', dedupeKey: `connection-request:${pending.id}` }), false)
      } finally { resume.resolve() }
    })
  })

  test(`${backend}: tombstones respect isolation, dedupe, retention and account deletion`, { skip: backend === 'neo4j' && !endpoint }, async () => {
    const f = await fixture(backend), feed = createNotifications({ store: f.notificationStore, keep: 1 })
    const notify = (key, recipient = b) => feed.notify({ recipient, actor: a, actorName: 'Sender', kind: 'connection_request_received', dedupeKey: key })
    const missing = `missing:${randomUUID()}`
    await feed.retract(missing, b)
    assert.equal(await notify(missing), false)
    const first = `first:${randomUUID()}`, second = `second:${randomUUID()}`
    assert.equal(await notify(first), true)
    const item = (await feed.list(b))[0]
    assert.equal(await feed.open(c, item.id), null)
    assert.equal(await notify(first), false)
    await feed.retract(first)
    assert.equal(await feed.open(b, item.id), null)
    await feed.markSeen(b); await feed.markAllRead(b); await feed.markReadByKey(b, first)
    assert.equal(await notify(second), true)
    assert.equal(await notify(`third:${randomUUID()}`), true)
    assert.equal((await feed.list(b)).length, 1)
    assert.deepEqual(await feed.counts(c), { unseen: 0, unread: 0 })
    assert.equal(await notify(missing), false)
    assert.equal(await notify(first), false)
    assert.equal(await feed.removeOwner(b), 1)
    assert.deepEqual(await feed.list(b), [])
    assert.equal(await notify(missing), true)
    await feed.removeOwner(a)
    assert.deepEqual(await feed.list(b), [])
  })
}

test('neo4j: concurrent insert and retraction serialize on the dedupe record', { skip: !endpoint }, async () => {
  const f = await fixture('neo4j'), dedupeKey = `contended:${randomUUID()}`
  const locked = await f.driver.request('/db/neo4j/tx', 'MERGE (n:UnlinkedNotification {dedupeKey: $dedupeKey}) SET n._testLock = true RETURN n.dedupeKey', { dedupeKey })
  const transaction = new URL(locked.location).pathname
  try {
    const inserting = f.notificationStore.insertOnce({ id: randomUUID(), dedupeKey, recipientOwnerId: b.ownerId, recipientUserId: b.userId,
      actorOwnerId: a.ownerId, actorUserId: a.userId, actorName: 'Sender', kind: 'connection_request_received', createdAt: Date.now() })
    const retracting = f.notificationStore.deleteByKey(dedupeKey, b)
    const deadline = Date.now() + 10000
    while (true) {
      const result = await f.driver.run('SHOW TRANSACTIONS YIELD status RETURN status')
      if (result.records.filter(record => String(record.get('status')).startsWith('Blocked')).length >= 2) break
      assert.ok(Date.now() < deadline, 'both notification writers must wait on the dedupe record')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await f.driver.request(`${transaction}/commit`)
    await Promise.all([inserting, retracting])
    assert.deepEqual(await f.notifications.list(b), [])
    assert.deepEqual(await f.notifications.counts(b), { unseen: 0, unread: 0 })
    assert.equal(await f.notifications.notify({ recipient: b, actor: a, kind: 'connection_request_received', dedupeKey }), false)
  } finally { await fetch(`${endpoint}${transaction}`, { method: 'DELETE' }) }
})

test('neo4j: pruning rechecks a notification after acquiring its lock', { skip: !endpoint }, async () => {
  const f = await fixture('neo4j'), dedupeKey = `pruning:${randomUUID()}`
  await f.notifications.notify({ recipient: b, actor: a, kind: 'connection_request_received', dedupeKey })
  const locked = await f.driver.request('/db/neo4j/tx', 'MATCH (n:UnlinkedNotification {dedupeKey: $dedupeKey}) SET n._testLock = true RETURN n.dedupeKey', { dedupeKey })
  const transaction = new URL(locked.location).pathname
  try {
    const pruning = f.notificationStore.prune(b, 0)
    const deadline = Date.now() + 10000
    while (true) {
      const result = await f.driver.run('SHOW TRANSACTIONS YIELD status RETURN status')
      if (result.records.some(record => String(record.get('status')).startsWith('Blocked'))) break
      assert.ok(Date.now() < deadline, 'pruning must wait on the notification lock')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await f.driver.request(`${transaction}/commit`, 'MATCH (n:UnlinkedNotification {dedupeKey: $dedupeKey}) SET n.retracted = true REMOVE n.id, n.kind RETURN n.dedupeKey', { dedupeKey })
    await pruning
    assert.deepEqual(await f.notifications.list(b), [])
    assert.equal(await f.notifications.notify({ recipient: b, actor: a, kind: 'connection_request_received', dedupeKey }), false)
  } finally { await fetch(`${endpoint}${transaction}`, { method: 'DELETE' }) }
})
