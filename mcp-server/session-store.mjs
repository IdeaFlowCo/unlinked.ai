export function createMemorySessionStore() {
  const records = new Map()
  return {
    async initialize() {},
    async get(idHash, now) {
      const record = records.get(idHash)
      if (!record) return null
      if (record.expiresAt <= now) {
        records.delete(idHash)
        return null
      }
      return structuredClone(record)
    },
    async put(idHash, record) {
      records.set(idHash, structuredClone(record))
    },
    async delete(idHash) {
      records.delete(idHash)
    },
    async deleteOwner(ownerId) {
      for (const [id, record] of records) {
        if (record.ownerId === ownerId) records.delete(id)
      }
    },
    async prune(now) {
      for (const [id, record] of records) {
        if (record.expiresAt <= now) records.delete(id)
      }
    }
  }
}

const RECORD_KEYS = ['ownerId', 'userId', 'accountLabel', 'displayName', 'csrf', 'expiresAt', 'createdAt']

const fromNode = properties => {
  const value = {}
  for (const name of RECORD_KEYS) {
    if (properties[name] !== undefined && properties[name] !== null) {
      value[name] = typeof properties[name]?.toNumber === 'function' ? properties[name].toNumber() : properties[name]
    }
  }
  return value
}

export function createNeo4jSessionStore(driver, database = 'neo4j') {
  const read = async (query, params) => { const session = driver.session({ database, defaultAccessMode: 'READ' }); try { return await session.executeRead(tx => tx.run(query, params)) } finally { await session.close() } }
  const write = async (query, params) => { const session = driver.session({ database }); try { return await session.executeWrite(tx => tx.run(query, params)) } finally { await session.close() } }
  const one = result => result.records.length ? fromNode(result.records[0].get('s')) : null
  
  return {
    async initialize() {
      await write('CREATE CONSTRAINT unlinked_session_id_hash IF NOT EXISTS FOR (s:UnlinkedSession) REQUIRE s.idHash IS UNIQUE', {})
      await write('CREATE INDEX unlinked_session_owner_id IF NOT EXISTS FOR (s:UnlinkedSession) ON (s.ownerId)', {})
    },
    async get(idHash, now) {
      const record = one(await read('MATCH (s:UnlinkedSession {idHash: $idHash}) RETURN properties(s) AS s', { idHash }))
      if (!record) return null
      if (record.expiresAt <= now) {
        await write('MATCH (s:UnlinkedSession {idHash: $idHash}) DETACH DELETE s', { idHash })
        return null
      }
      return record
    },
    async put(idHash, record) {
      const stored = Object.fromEntries(RECORD_KEYS.filter(name => record[name] !== undefined && record[name] !== null).map(name => [name, record[name]]))
      // `SET s = map` replaces every property, so the key goes back in with it.
      await write('MERGE (s:UnlinkedSession {idHash: $idHash}) SET s = $stored, s.idHash = $idHash', { idHash, stored })
    },
    async delete(idHash) {
      await write('MATCH (s:UnlinkedSession {idHash: $idHash}) DETACH DELETE s', { idHash })
    },
    async deleteOwner(ownerId) {
      await write('MATCH (s:UnlinkedSession {ownerId: $ownerId}) DETACH DELETE s', { ownerId })
    },
    async prune(now) {
      await write('MATCH (s:UnlinkedSession) WHERE s.expiresAt <= $now DETACH DELETE s', { now })
    }
  }
}
