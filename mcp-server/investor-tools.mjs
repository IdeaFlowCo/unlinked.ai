import { z } from 'zod'
import { createHash } from 'node:crypto'
import { createInvestorJobs } from '../src/utils/private-import/investor-job.mjs'
import { unicodeChunkEnd } from '../src/utils/private-import/unicode-chunk.mjs'
import { MAX_PRIVATE_PERSON_REFS } from './private-context.mjs'

const importId = z.string().regex(/^[a-f0-9]{64}$/)
const column = z.string().min(1).max(32768)
export const INVESTOR_TOOLS = Object.freeze(['unlinked_stage_investor_csv', 'unlinked_resume_investor_import', 'unlinked_get_investor_import'])
export const INVESTOR_MUTATING = new Set(INVESTOR_TOOLS.slice(0, 2))
export const INVESTOR_SCHEMAS = Object.freeze({
  unlinked_stage_investor_csv: { csv: z.string().min(1).max(512 * 1024).optional(), fileBase64: z.string().min(1).max(699052).optional(),
    filename: z.string().min(1).max(200).optional(), sheet: z.string().min(1).max(128).optional(), headerRow: z.number().int().min(1).max(100000).optional(), inspectOnly: z.boolean().optional(), retainOriginalConfirmed: z.boolean().optional(),
    listName: z.string().trim().min(1).max(120).optional(),
    listId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(), mapping: z.object({ name: column.optional(), firstName: column.optional(), lastName: column.optional(), linkedinUrl: column.optional(), email: column.optional(), company: column.optional(), title: column.optional(), notes: z.array(column).max(256).optional() }).strict().optional() },
  unlinked_resume_investor_import: { importId, batchSize: z.number().int().min(1).max(25).optional() },
  unlinked_get_investor_import: { importId, offset: z.number().int().min(0).max(100000).optional(), limit: z.number().int().min(1).max(20).optional(), sourceOffset: z.number().int().min(0).max(512 * 1024).optional() },
})
const PRIVATE = 'Requires Private people notes & relations permission. Owner-only; never publishes profiles or notifies anyone. It is NOT a connection request and NOT messaging.'
export const INVESTOR_DESCRIPTIONS = Object.freeze({
  unlinked_stage_investor_csv: `Inspect or stage an investor/contact CSV or XLSX in the owner’s private database (the tool name remains compatible). Supply exactly one of csv (UTF-8 text) or fileBase64 (canonical base64 original bytes, requires filename ending .csv or .xlsx); maximum original size 512 KiB. inspectOnly:true writes nothing and needs no mapping/listName: XLSX returns exact sheet names, ids, paths and visibility; with sheet set it also returns headers. XLSX staging always requires an exact sheet name, headerRow (1 by default), mapping, listName, and retainOriginalConfirmed:true ONLY after owner authorization to retain the ENTIRE original workbook including unselected/hidden tabs privately on the server. Only the selected sheet is imported; never guess a tab. Selected-sheet formulas, macros, encrypted or legacy .xls files are rejected; supply a values-only XLSX or CSV. Mapping uses exact header names; private comments use notes:[column names]. Returns importId and a new import’s validation preview; resume to commit. Same bytes, sheet/header, mapping, listName and list target replay the same import. Name/email never auto-match; exact LinkedIn references may match a readable persona, otherwise each source row becomes a private person. listId appends to an existing private list. Larger files must be split by complete rows, retaining headers; append later parts to the first listId. ${PRIVATE}`,
  unlinked_resume_investor_import: `Commit/resume one bounded batch (default 10, maximum 25 rows) from a staged CSV or selected XLSX sheet. Repeat with the same importId until status complete or partial; never report completion before then. Durable row receipts and idempotent graph writes survive process restarts. import_busy means retry later. On other errors, progress is retained: inspect status and retry after fixing the cause. Existing graph quotas apply (5,000 entities and links per owner). ${PRIVATE}`,
  unlinked_get_investor_import: `Read an investor import’s status and private original row fields with outcome receipts, including XLSX sheet and physical row provenance. Page with nextOffset until null, at most 20 rows per call, fewer when encoded fields are large. Oversized rows report sourceRecovery. Recover the original file with sourceOffset:0 and follow source.nextOffset until null. CSV returns source.text chunks (UTF-16 offsets, at most 32768 code units); XLSX returns source.base64 chunks (BYTE offsets, at most 32768 bytes). Decode EACH base64 chunk separately, concatenate bytes and verify sourceDigest. The entire original XLSX includes unselected/hidden sheets and remains owner-private. A partial import has rejected rows; inspect reasons. This reads original outcomes, not the owner’s subsequent graph edits/deletions. Query live lists with unlinked_list_private_things(kind:list,limit:100) and unlinked_get_private_thing(thingId:listId,limit:100), following nextCursor. ${PRIVATE}`,
})

export function createInvestorTools({ getBackend, who, overlayCall, existingByRef, person, provenance, fail }) {
  const graph = {
    async validate(grant, listId) {
      const identity = await who(grant)
      if (listId && (await overlayCall(identity, 'GET', `entities/${listId}`)).entity?.kind !== 'list') throw fail('invalid_input', 'listId must name one of the owner’s private lists.')
    },
    async list(grant, job, signal, revalidate) {
      const identity = await who(grant)
      signal?.throwIfAborted(); if (revalidate) await revalidate()
      const result = await overlayCall(identity, 'POST', 'entities', { kind: 'list', name: job.listName, createNew: true, clientRequestId: `investor-list:${job.id}` })
      return result.entity.id
    },
    async row(grant, job, row, signal, revalidate) {
      if (row.name.length > 120 || /[\x00-\x1f\x7f]/.test(row.name)) return { status: 'rejected', reason: 'invalid_name' }
      const identity = await who(grant), refs = []
      if (row.identity.linkedinRefHash) {
        refs.push(`linkedin:in:${row.identity.linkedinRefHash}`)
        try { refs.push(...(await person(grant, row.linkedinUrl, signal, { requireComplete: true })).refs) }
        catch (error) {
          if (error?.code === 'identity_conflict' && error.details?.reason === 'too_many_exact_references') return { status: 'rejected', reason: 'too_many_exact_references' }
          if (error?.code !== 'not_found') throw error
        }
      } else {
        refs.push(`unlinked:private:${createHash('sha256').update(`investor-row:${job.id}:${row.rowId}`).digest('hex').slice(0, 32)}`)
      }
      const unique = [...new Set(refs)], matches = []
      if (unique.length > MAX_PRIVATE_PERSON_REFS) return { status: 'rejected', reason: 'too_many_exact_references' }
      for (const ref of unique) {
        signal?.throwIfAborted()
        const entity = await existingByRef(identity, ref)
        if (entity && !matches.some(value => value.id === entity.id)) matches.push(entity)
      }
      if (matches.length > 1 || matches.some(entity => entity.kind !== 'person')) return { status: 'rejected', reason: 'conflicting_exact_references', candidates: matches.map(entity => ({ id: entity.id, name: entity.name })) }
      signal?.throwIfAborted(); if (revalidate) await revalidate()
      const saved = await overlayCall(identity, 'POST', 'entities', { kind: 'person', name: matches[0]?.name ?? row.name, refs: unique })
      if (saved.unattached?.length) throw fail('identity_conflict', 'Exact references changed during import; inspect the private person and retry.')
      const entityId = saved.entity.id, noteIds = []
      const context = [['Company', row.company], ['Title', row.title], ['Email (source only)', row.email], ['LinkedIn (source)', row.linkedinUrl]]
        .filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n')
      const notes = [...(context ? [{ column: 'Source details', text: context }] : []), ...row.notes]
      for (const [index, note] of notes.entries()) {
        // Each source occurrence retains its own contribution; independent
        // manual notes are never overwritten by this import or a replay.
        const sourceLabel = job.source?.format === 'xlsx' ? `XLSX ${job.id} sheet ${job.source.selectedSheet.id}` : `CSV ${job.id}`
        const prefix = `${sourceLabel} row ${row.row} field ${index + 1}\n`
        const text = `${note.column}\n${note.text}`
        for (let start = 0, part = 1; start < text.length; part++) {
          signal?.throwIfAborted(); if (revalidate) await revalidate()
          const header = `${prefix}part ${part}\n`, chunk = text.slice(start, unicodeChunkEnd(text, start, 4000 - header.length))
          start += chunk.length
          const added = await overlayCall(identity, 'POST', `entities/${entityId}/notes`, { text: header + chunk, provenance: provenance(grant) })
          noteIds.push(added.note.id)
        }
      }
      signal?.throwIfAborted(); if (revalidate) await revalidate()
      const sourceLabel = job.source?.format === 'xlsx' ? `XLSX ${job.id} sheet ${job.source.selectedSheet.id}` : `CSV ${job.id}`
      const linked = await overlayCall(identity, 'POST', `entities/${job.listId}/links`, { toId: entityId, relation: 'contains', provenance: provenance(grant), context: `${sourceLabel} row ${row.row}` })
      return { status: 'imported', entityId, membershipId: linked.link.id, noteIds,
        identity: row.identity.linkedinRefHash ? 'exact_linkedin_reference' : 'separate_source_row', sourceIdentityStatus: row.identity.status }
    },
  }
  const jobs = createInvestorJobs({ getBackend, graph, fail })
  return {
    unlinked_stage_investor_csv: (...args) => jobs.stage(...args),
    unlinked_resume_investor_import: (...args) => jobs.resume(...args),
    unlinked_get_investor_import: (...args) => jobs.status(...args),
  }
}
