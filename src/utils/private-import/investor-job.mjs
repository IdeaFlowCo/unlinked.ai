import { createHash, randomUUID } from 'node:crypto'
import { investorFileInput, parseInvestorFile, INVESTOR_FILE_BYTES } from './investor-file.mjs'
import { privateId } from './job.mjs'
import { isUnicodeBoundary, unicodeChunkEnd } from './unicode-chunk.mjs'

export const INVESTOR_UPLOAD_BYTES = INVESTOR_FILE_BYTES
export const INVESTOR_JOB_KIND = 'investor_csv_v1'
const KIND = INVESTOR_JOB_KIND
export const investorCatalogId = owner => privateId(owner, KIND, 'catalog')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)))
export const investorReceiptId = (owner, id, ordinal) => privateId(owner, KIND, id, 'row', ordinal)
const summary = job => ({ importId: job.id, status: job.status, listId: job.listId, listName: job.listName,
  total: job.total, processed: job.offset, imported: job.imported, rejected: job.rejected,
  sourceDigest: job.sourceDigest, ...(job.source ? { sourceFile: job.source } : {}), mapping: job.mapping, visibility: 'owner_private',
  nextAction: job.status === 'complete' || job.status === 'partial' ? null : 'unlinked_resume_investor_import' })

// Only operational owner resources and immutable private assets are used here.
// `kind` keeps these out of archive publication, worker and connection readers.
// Graph writes are independently idempotent; the receipt precedes the checkpoint.
export function createInvestorJobs({ getBackend, graph, fail, now = Date.now }) {
  const backendFor = grant => getBackend({ ownerId: grant.ownerId, userId: grant.userId })
  const read = async (backend, ownerId, id, kind = KIND) => {
    const resource = await backend.readResource('import', id)
    if (!resource || resource.deleted || resource.sourceOwnerId !== ownerId || resource.payload?.ownerId !== ownerId || resource.payload?.kind !== kind) throw fail('not_found', 'No private investor import has that id.')
    return resource.payload
  }
  const resource = (ownerId, value, expectedRevision) => ({ namespace: 'unlinked', type: 'import', sourceId: value.id, sourceOwnerId: ownerId,
    audience: 'owner', deleted: false, sourceRevision: value.revision, expectedRevision, payload: value })
  const write = async (backend, ownerId, value, expectedRevision) => {
    try {
      await backend.writeResource(resource(ownerId, value, expectedRevision))
    } catch (error) {
      if (error?.message === 'private_noos_409') throw fail('import_busy', 'Another request changed this import; read its status and retry.')
      throw error
    }
  }
  const sourceFor = async (backend, job) => {
    const bytes = await backend.readAsset(job.sourceDigest)
    if (sha(bytes) !== job.sourceDigest) throw fail('upstream_unavailable', 'The private original source could not be verified.')
    return bytes
  }
  const rowsFor = async (backend, job) => {
    const bytes = await sourceFor(backend, job)
    const parsed = parseInvestorFile(bytes, job.source, job.mapping, { parserVersion: job.parserVersion })
    return [...parsed.accepted, ...parsed.rejected].sort((a, b) => a.row - b.row)
  }
  const catalogFor = async (backend, ownerId, importId) => {
    const id = investorCatalogId(ownerId), stored = await backend.readResource('import', id)
    const current = stored ? await read(backend, ownerId, id, `${KIND}_catalog`) : null
    if (!current?.importIds.includes(importId) && (current?.importIds.length ?? 0) >= 500) throw fail('invalid_input', 'Private CSV import catalog is full (500 imports).')
    return current
  }
  const publish = async (backend, ownerId, job, beforeWrite) => {
    const id = investorCatalogId(ownerId)
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await backend.readResource('import', job.id)) return { job: await read(backend, ownerId, job.id), created: false }
      const current = await catalogFor(backend, ownerId, job.id)
      const catalog = { id, kind: `${KIND}_catalog`, ownerId, revision: (current?.revision ?? 0) + 1,
        importIds: [...new Set([...(current?.importIds ?? []), job.id])] }
      try {
        await beforeWrite()
        // Both records become visible in one owner-fenced transaction. Failed
        // staging cannot reserve catalog capacity or leave an undiscoverable job.
        await backend.writeImportBatch([resource(ownerId, catalog, current?.revision ?? null), resource(ownerId, job, null)])
        return { job, created: true }
      } catch (error) {
        if (error?.message !== 'private_noos_409') throw error
        if (attempt === 4) throw fail('import_busy', 'Another request changed this import; read its status and retry.')
      }
    }
  }
  return {
    async stage(grant, input, signal, revalidate) {
      signal?.throwIfAborted()
      const { mapping, listName, listId, inspectOnly = false } = input
      let parsed, bytes, source
      try {
        ;({ bytes, source } = investorFileInput(input))
        parsed = parseInvestorFile(bytes, source, mapping, { inspectOnly })
      } catch (error) {
        if (error.message === 'xlsx_formula_unsupported') {
          throw fail('invalid_input', `Formula in cell ${error.details.cell} is unsupported (xlsx_formula_unsupported). Replace formulas with values in a copy, or export a values-only CSV. For HYPERLINK formulas, put the actual LinkedIn URL in the mapped URL column; the displayed name is not a URL.`,
            { failureReason: 'xlsx_formula_unsupported', ...error.details, recovery: 'values_only_export' })
        }
        throw fail('invalid_input', `File validation failed (${error.message}).`)
      }
      const disclosure = 'The entire original workbook, including unselected and hidden sheets, is retained privately on the server. Only the explicitly selected sheet is imported. Requires owner authorization for retaining the whole file.'
      if (inspectOnly) return source.format === 'xlsx' ? { ...parsed, disclosure, requiredAcknowledgement: 'retainOriginalConfirmed:true' } : parsed
      if (source.format === 'xlsx' && input.retainOriginalConfirmed !== true) throw fail('invalid_input', `Set retainOriginalConfirmed:true only after owner authorization. ${disclosure}`)
      if (typeof listName !== 'string' || !listName.trim() || listName.length > 120 || /[\x00-\x1f\x7f]/.test(listName)) throw fail('invalid_input', 'A valid listName is required to stage an import.')
      if (!parsed.accepted.length && !parsed.rejected.length) throw fail('invalid_input', 'File has no data rows.')
      const canonicalMapping = sorted(mapping)
      const identity = [grant.ownerId, KIND, parsed.sourceDigest, JSON.stringify(canonicalMapping), listName, listId ?? '']
      if (source.format === 'xlsx') identity.push(source.sheet, source.headerRow, parsed.parserVersion)
      const id = privateId(...identity)
      if (parsed.selectedSheet) source.selectedSheet = parsed.selectedSheet
      const job = { kind: KIND, ownerId: grant.ownerId, id, revision: 1, createdAt: now(), sourceDigest: parsed.sourceDigest,
        source, parserVersion: parsed.parserVersion,
        ...(source.format === 'xlsx' ? { disclosure: { version: 'investor-workbook-v1', originalWorkbookRetentionConfirmed: true, selectedSheetOnlyImported: true } } : {}),
        mapping: canonicalMapping, listName, listId: listId ?? null, status: 'staged', offset: 0, imported: 0, rejected: 0,
        total: parsed.accepted.length + parsed.rejected.length, lease: null }
      if (Buffer.byteLength(JSON.stringify(job)) > 60000) throw fail('invalid_input', 'CSV column mapping exceeds the import metadata limit.')
      const backend = await backendFor(grant)
      const existing = await backend.readResource('import', id)
      if (existing) return summary(await read(backend, grant.ownerId, id))
      if (typeof backend.writeImportBatch !== 'function') throw fail('upstream_unavailable', 'Atomic private import storage is unavailable.')
      // Validate the private graph identity before storing any source.
      await graph.validate(grant, listId)
      const beforeWrite = async () => { signal?.throwIfAborted(); if (revalidate) await revalidate(); signal?.throwIfAborted() }
      await catalogFor(backend, grant.ownerId, id)
      await backend.adapter.withImport(grant.ownerId, id, async store => { await beforeWrite(); await store.putAsset(parsed.sourceDigest, bytes) })
      const published = await publish(backend, grant.ownerId, job, beforeWrite)
      if (!published.created) return summary(published.job)
      return { ...summary(published.job), preview: { valid: parsed.accepted.length, rejected: parsed.rejected.length,
        exactReferences: parsed.accepted.filter(row => row.identity.linkedinRefHash).length,
        separatePeople: parsed.accepted.filter(row => !row.identity.linkedinRefHash).length },
        policy: 'Private only. Exact LinkedIn references may match; names and emails never merge. No connections or public profiles are created. Resume to commit.' }
    },
    async status(grant, { importId, offset = 0, limit = 20, sourceOffset }, signal) {
      const backend = await backendFor(grant), job = await read(backend, grant.ownerId, importId)
      if (sourceOffset !== undefined) {
        const bytes = await sourceFor(backend, job)
        if (job.source?.format === 'xlsx') {
          if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset > bytes.length) throw fail('invalid_input', 'Source offset exceeds this import.')
          signal?.throwIfAborted()
          const next = Math.min(sourceOffset + 32768, bytes.length)
          return { ...summary(job), source: { base64: bytes.subarray(sourceOffset, next).toString('base64'), offset: sourceOffset,
            nextOffset: next < bytes.length ? next : null, offsetUnit: 'bytes', encoding: 'base64' } }
        }
        const csv = bytes.toString('utf8')
        if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset > csv.length) throw fail('invalid_input', 'Source offset exceeds this import.')
        if (!isUnicodeBoundary(csv, sourceOffset)) throw fail('invalid_input', 'Source offset splits a Unicode character.')
        signal?.throwIfAborted()
        const next = unicodeChunkEnd(csv, sourceOffset, 32768), text = csv.slice(sourceOffset, next)
        return { ...summary(job), source: { text, offset: sourceOffset, nextOffset: next < csv.length ? next : null, offsetUnit: 'utf16_code_units' } }
      }
      if (offset > job.total) throw fail('invalid_input', 'Offset exceeds this import.')
      const rows = await rowsFor(backend, job), receipts = []
      let receiptBytes = 0
      for (let i = offset; i < Math.min(offset + limit, job.total); i++) {
        signal?.throwIfAborted()
        const resource = await backend.readResource('import', investorReceiptId(grant.ownerId, importId, i))
        const receipt = resource ? await read(backend, grant.ownerId, investorReceiptId(grant.ownerId, importId, i), `${KIND}_row`) : null
        const entry = { ordinal: i, sourceRow: rows[i].row, rowId: rows[i].rowId, fields: rows[i].fields ?? null,
          ...(job.source?.selectedSheet ? { sourceSheet: job.source.selectedSheet } : {}),
          ...(rows[i].sourceValues ? { sourceValues: rows[i].sourceValues } : {}),
          ...(rows[i].sourceHyperlink ? { sourceHyperlink: rows[i].sourceHyperlink } : {}),
          result: receipt?.result ?? { status: rows[i].reason ? 'rejected' : 'pending', ...(rows[i].reason ? { reason: rows[i].reason } : {}) } }
        if (Buffer.byteLength(JSON.stringify(entry)) > 512 * 1024) {
          delete entry.sourceValues
          entry.fields = null
          entry.sourceRecovery = { reason: 'encoded_row_limit', sourceOffset: 0 }
        }
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (receipts.length && receiptBytes + size > 512 * 1024) break
        receipts.push(entry); receiptBytes += size
      }
      return { ...summary(job), receipts, nextOffset: offset + receipts.length < job.total ? offset + receipts.length : null }
    },
    async resume(grant, { importId, batchSize = 10 }, signal, revalidate) {
      const backend = await backendFor(grant)
      const beforeWrite = async () => { signal?.throwIfAborted(); if (revalidate) await revalidate(); signal?.throwIfAborted() }
      let job = await read(backend, grant.ownerId, importId)
      if (['complete', 'partial'].includes(job.status)) return summary(job)
      if (job.lease?.until > now()) throw fail('import_busy', 'This import has an active batch; retry after its lease expires.', { retryAfterMs: job.lease.until - now() })
      const token = randomUUID()
      const save = async patch => {
        await beforeWrite()
        const next = { ...job, ...patch, revision: job.revision + 1 }
        await write(backend, grant.ownerId, next, job.revision)
        job = next
      }
      await save({ status: 'processing', lease: { token, until: now() + 300000 } })
      try {
        const rows = await rowsFor(backend, job)
        signal?.throwIfAborted()
        if (revalidate) await revalidate()
        // Existing lists must still exist; never recreate a removed list.
        if (job.listId) await graph.validate(grant, job.listId)
        else await save({ listId: await graph.list(grant, job, signal, beforeWrite) })
        const stop = Math.min(job.total, job.offset + batchSize)
        while (job.offset < stop) {
          signal?.throwIfAborted()
          if (revalidate) await revalidate()
          // Renew by CAS before starting the next row. A timed-out predecessor
          // cannot advance a checkpoint after another runtime acquires the job.
          await save({ lease: { token, until: now() + 300000 } })
          const ordinal = job.offset, row = rows[ordinal], id = investorReceiptId(grant.ownerId, job.id, ordinal)
          const existing = await backend.readResource('import', id)
          let result
          if (existing) result = (await read(backend, grant.ownerId, id, `${KIND}_row`)).result
          else {
            result = row.reason ? { status: 'rejected', reason: row.reason } : await graph.row(grant, job, row, signal, async () => {
              await save({ lease: { token, until: now() + 300000 } })
              // The lease write itself can be in flight when access changes.
              // Recheck after it resolves, before starting the graph write.
              await beforeWrite()
            })
            await beforeWrite()
            await write(backend, grant.ownerId, { kind: `${KIND}_row`, ownerId: grant.ownerId, id, revision: 1,
              importId: job.id, ordinal, sourceRow: row.row, rowId: row.rowId, result }, null)
          }
          await save({ offset: ordinal + 1, imported: job.imported + Number(result.status === 'imported'), rejected: job.rejected + Number(result.status !== 'imported') })
        }
        await save({ status: job.offset === job.total ? job.rejected ? 'partial' : 'complete' : 'processing', lease: null })
        return summary(job)
      } catch (error) {
        // Best effort release; a lost CAS must never overwrite a newer lease.
        try { await save({ lease: null }) } catch { /* the stored checkpoint wins */ }
        throw error
      }
    },
  }
}

// Account lifecycle uses a deterministic private catalog: these jobs never
// enter the archive/connection discovery indexes. New stages publish the job
// and catalog atomically; defensively skip missing legacy/deleted records.
export async function investorJobsForAccount(ownerId, backend) {
  const catalog = await backend.readResource('import', investorCatalogId(ownerId))
  if (!catalog || catalog.deleted) return { catalog: null, jobs: [] }
  if (catalog.sourceOwnerId !== ownerId || catalog.payload?.kind !== `${KIND}_catalog` ||
      !Array.isArray(catalog.payload.importIds) || catalog.payload.importIds.length > 500) throw new Error('private_investor_catalog_invalid')
  const jobs = []
  for (const id of catalog.payload.importIds) {
    const resource = await backend.readResource('import', id)
    if (resource && !resource.deleted && resource.sourceOwnerId === ownerId && resource.payload?.kind === KIND) jobs.push(resource)
  }
  return { catalog, jobs }
}
