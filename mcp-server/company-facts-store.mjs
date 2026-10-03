import { createHash } from 'node:crypto'
import { COMPANY_DATASET, validateCompanyRows } from './company-metadata.mjs'

// Graph storage for operator-published company facts (docs/company-facts.md).
// Noos's UnlinkedPublicPeopleStore only accepts person-shaped rows, so company
// rows get their own small labels with the same publication model:
//   (:UnlinkedCompanyDataset {id})                  pointer to the live revision
//   (:UnlinkedCompanyRevision {dataset, revision})  staging | published | deleted
//   (:UnlinkedCompanyChunk {dataset, revision, ordinal})  immutable JSON rows
// Every lookup is by a uniquely constrained key on these dedicated labels; no
// query ever scans OperationalResource documents.
const hash = value => createHash('sha256').update(value).digest('hex')
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value)
const CHUNK_BYTES = 128 * 1024, CHUNK_ROWS = 200, MAX_CHUNKS = 64

export const companyRevision = companies => COMPANY_DATASET + ':' + hash(JSON.stringify(companies))

function chunksOf(companies) {
  const chunks = []
  let group = []
  const flush = () => { if (!group.length) return; const json = JSON.stringify(group); chunks.push({ ordinal: chunks.length, json, sha256: hash(json), rows: group.length }); group = [] }
  for (const row of companies) {
    if (Buffer.byteLength(JSON.stringify([row])) > CHUNK_BYTES) throw new Error('company_row_limit')
    if (group.length >= CHUNK_ROWS || Buffer.byteLength(JSON.stringify([...group, row])) > CHUNK_BYTES) flush()
    group.push(row)
  }
  flush()
  if (chunks.length > MAX_CHUNKS) throw new Error('company_chunk_limit')
  return chunks
}

export function createNeo4jCompanyFactsStore(driver, database = 'neo4j') {
  let ready = false
  const requireReady = () => { if (!ready) throw new Error('company_store_unavailable') }
  const locked = async (tx, dataset, revision) => {
    const result = await tx.run('MATCH (r:UnlinkedCompanyRevision {dataset: $dataset, revision: $revision}) SET r._lock = true REMOVE r._lock RETURN r.state AS state', { dataset, revision })
    if (!result.records.length) throw new Error('company_revision_missing')
    if (result.records[0].get('state') === 'deleted') throw new Error('company_revision_deleted')
  }
  return {
    async initialize() {
      const session = driver.session({ database })
      try {
        await session.run('CREATE CONSTRAINT unlinked_company_dataset IF NOT EXISTS FOR (p:UnlinkedCompanyDataset) REQUIRE p.id IS UNIQUE')
        await session.run('CREATE CONSTRAINT unlinked_company_revision IF NOT EXISTS FOR (r:UnlinkedCompanyRevision) REQUIRE (r.dataset, r.revision) IS UNIQUE')
        await session.run('CREATE CONSTRAINT unlinked_company_chunk IF NOT EXISTS FOR (c:UnlinkedCompanyChunk) REQUIRE (c.dataset, c.revision, c.ordinal) IS UNIQUE')
        ready = true
      } finally { await session.close() }
    },
    // Content-addressed and idempotent. Chunks are written under a staging
    // revision; the single final transaction moves the pointer, guarded by the
    // revision the caller last saw. Publishing an earlier, still-published
    // revision again just moves the pointer back to it (roll forward to old rows).
    async publish(dataset, input, sourceSha256, expectedRevision = null) {
      requireReady()
      if (dataset !== COMPANY_DATASET || !/^[a-f0-9]{64}$/.test(sourceSha256) || (expectedRevision !== null && !identifier(expectedRevision))) throw new Error('company_publication_invalid')
      const companies = validateCompanyRows(input), revision = companyRevision(companies), chunks = chunksOf(companies), digest = hash(JSON.stringify(companies))
      const session = driver.session({ database })
      let replayed = false
      try {
        await session.executeWrite(async tx => {
          const result = await tx.run(`MERGE (r:UnlinkedCompanyRevision {dataset: $dataset, revision: $revision})
            ON CREATE SET r.state = 'staging', r.digest = $digest, r.sourceSha256 = $sourceSha256, r.chunkCount = $chunkCount, r.companyCount = $companyCount
            SET r._lock = true REMOVE r._lock RETURN r.state AS state, r.digest AS digest`,
          { dataset, revision, digest, sourceSha256, chunkCount: chunks.length, companyCount: companies.length })
          const prior = result.records[0]
          if (prior.get('digest') !== digest) throw new Error('company_revision_conflict')
          if (prior.get('state') === 'deleted') throw new Error('company_revision_deleted')
          replayed = prior.get('state') === 'published'
        })
        if (!replayed) for (const chunk of chunks) await session.executeWrite(async tx => {
          await locked(tx, dataset, revision)
          const result = await tx.run(`MERGE (c:UnlinkedCompanyChunk {dataset: $dataset, revision: $revision, ordinal: $ordinal})
            ON CREATE SET c.json = $json, c.sha256 = $sha256, c.rowCount = $rows RETURN c.sha256 AS sha256, c.json AS json`, { dataset, revision, ...chunk })
          if (result.records[0].get('sha256') !== chunk.sha256 || result.records[0].get('json') !== chunk.json) throw new Error('company_chunk_conflict')
        })
        await session.executeWrite(async tx => {
          await locked(tx, dataset, revision)
          const pointer = await tx.run('MERGE (p:UnlinkedCompanyDataset {id: $dataset}) SET p._lock = true REMOVE p._lock RETURN p.revision AS revision', { dataset })
          const current = pointer.records[0].get('revision') ?? null
          if (current !== expectedRevision && current !== revision) throw new Error('company_pointer_conflict')
          const count = await tx.run(`MATCH (c:UnlinkedCompanyChunk {dataset: $dataset, revision: $revision}) WHERE c.ordinal IS NOT NULL
            RETURN count(c) AS chunks, coalesce(sum(c.rowCount), 0) AS rows`, { dataset, revision })
          if (Number(count.records[0].get('chunks')) !== chunks.length || Number(count.records[0].get('rows')) !== companies.length) throw new Error('company_publication_incomplete')
          await tx.run(`MATCH (r:UnlinkedCompanyRevision {dataset: $dataset, revision: $revision}) SET r.state = 'published'
            MERGE (p:UnlinkedCompanyDataset {id: $dataset}) SET p.revision = $revision`, { dataset, revision })
        })
        return { revision, companies: companies.length, replayed, previousRevision: expectedRevision }
      } finally { await session.close() }
    },
    // The live revision, verified chunk by chunk, or null when nothing is published.
    async read(dataset = COMPANY_DATASET) {
      requireReady()
      if (dataset !== COMPANY_DATASET) throw new Error('company_dataset_invalid')
      const session = driver.session({ database, defaultAccessMode: 'READ' })
      try {
        const result = await session.executeRead(tx => tx.run(`MATCH (p:UnlinkedCompanyDataset {id: $dataset})
          MATCH (r:UnlinkedCompanyRevision {dataset: $dataset, revision: p.revision}) WHERE r.state = 'published'
          OPTIONAL MATCH (c:UnlinkedCompanyChunk {dataset: $dataset, revision: p.revision}) WHERE c.ordinal IS NOT NULL
          RETURN r.revision AS revision, r.digest AS digest, r.chunkCount AS chunkCount, c.ordinal AS ordinal, c.json AS json, c.sha256 AS sha256
          ORDER BY ordinal LIMIT ${MAX_CHUNKS + 1}`, { dataset }))
        if (!result.records.length) return null
        const first = result.records[0], chunkCount = Number(first.get('chunkCount'))
        if (result.records.length !== chunkCount || chunkCount > MAX_CHUNKS) throw new Error('company_dataset_corrupt')
        const companies = []
        result.records.forEach((record, index) => {
          const json = record.get('json')
          if (Number(record.get('ordinal')) !== index || typeof json !== 'string' || hash(json) !== record.get('sha256')) throw new Error('company_dataset_corrupt')
          companies.push(...JSON.parse(json))
        })
        const valid = validateCompanyRows(companies)
        if (hash(JSON.stringify(valid)) !== first.get('digest') || companyRevision(valid) !== first.get('revision')) throw new Error('company_dataset_corrupt')
        return { dataset, revision: first.get('revision'), companies: valid }
      } finally { await session.close() }
    },
    // Rollback: the revision is marked deleted and, if live, the pointer is
    // removed, so pages fall back to the static list. Chunks stay for audit.
    async revoke(dataset, revision) {
      requireReady()
      if (dataset !== COMPANY_DATASET || !identifier(revision)) throw new Error('company_revision_invalid')
      const session = driver.session({ database })
      try {
        await session.executeWrite(async tx => {
          await locked(tx, dataset, revision)
          await tx.run(`MATCH (r:UnlinkedCompanyRevision {dataset: $dataset, revision: $revision}) SET r.state = 'deleted'
            WITH r OPTIONAL MATCH (p:UnlinkedCompanyDataset {id: $dataset}) WHERE p.revision = $revision DELETE p`, { dataset, revision })
        })
      } finally { await session.close() }
    },
  }
}
