// Upload a list of people from a CSV in the browser (unlinked-h2e4), for
// example LinkedIn followers, which LinkedIn's data export does not include.
// It reuses the private list import (docs/investor-csv.md, PR #238): the
// people become owner-private list members, never connections, never public.
// This module only maps columns, runs the import's batches in the background
// as the signed-in owner, and reads status; every rule lives in that import.
import Papa from 'papaparse'

export const LIST_UPLOAD_BYTES = 512 * 1024
export const LIST_TOOLS = Object.freeze(['unlinked_stage_investor_csv', 'unlinked_resume_investor_import', 'unlinked_get_investor_import'])
export const DEFAULT_LIST_NAME = 'LinkedIn followers'

// Common column names from LinkedIn analytics exports, follower exporters and
// hand-made sheets, matched case- and spacing-insensitively. First match wins.
const COLUMN_NAMES = {
  name: ['name', 'full name', 'fullname', 'follower name', 'follower', 'member name'],
  firstName: ['first name', 'firstname', 'first', 'given name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  linkedinUrl: ['linkedin url', 'linkedin profile url', 'profile url', 'public profile url', 'linkedin profile', 'linkedin', 'profile link', 'profile', 'url'],
  title: ['headline', 'title', 'job title', 'position', 'occupation'],
  company: ['company', 'company name', 'current company', 'organization', 'organisation'],
  email: ['email', 'email address', 'e mail'],
}
const normalize = value => String(value).normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, ' ')

// The header row's mapping for the private list import, or an error code.
export function detectListMapping(csvText) {
  const parsed = Papa.parse(csvText.replace(/^﻿/, ''), { preview: 1 })
  const headers = (parsed.data[0] ?? []).map(value => String(value).trim())
  if (!headers.length || headers.every(value => !value)) return { error: 'list_header_missing', headers: [] }
  const byName = new Map(headers.map(header => [normalize(header), header]))
  const mapping = {}, used = new Set()
  for (const [key, names] of Object.entries(COLUMN_NAMES)) {
    const header = names.map(name => byName.get(name)).find(value => value && !used.has(value))
    if (header) { mapping[key] = header; used.add(header) }
  }
  // A full name wins over split names; never send both for the same person.
  if (mapping.name) { delete mapping.firstName; delete mapping.lastName }
  if (!mapping.name && !mapping.firstName && !mapping.lastName) return { error: 'list_name_column_missing', headers }
  return { mapping, headers }
}

export const LIST_ERRORS = Object.freeze({
  list_header_missing: 'That file has no header row. The first row should name the columns, for example Name and Profile URL.',
  list_name_column_missing: 'We couldn’t find a name column. Name a column “Name” (or “First Name” and “Last Name”), and include “Profile URL” if you have LinkedIn addresses.',
  list_too_large: 'That file is larger than 512 KB. Split it into smaller files and upload each one; they all go into the same list.',
  list_not_utf8: 'That file isn’t saved as UTF-8 text. Re-save it as “CSV UTF-8” and upload it again.',
  list_not_csv: 'Upload a .csv file.',
  list_unavailable: 'Lists are unavailable right now. Nothing was imported; try again in a minute.',
  list_failed: 'That file could not be imported. Check that it is a CSV with a header row, then try again.',
})

// `call(owner, name, input)` runs one of LIST_TOOLS for the signed-in owner
// (an in-process owner grant; see private-pilot.mjs). One runner per owner;
// batches are paced well under the owner's per-minute tool budget.
export function createPrivateListImports({ call, pauseMs = 1500, batchSize = 25, maxBatches = 4000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()) }) {
  if (typeof call !== 'function') throw new TypeError('private_list_imports_configuration_required')
  const running = new Map()
  const run = (owner, importId) => {
    const key = `${owner.ownerId}\u0000${importId}`
    if (running.has(key)) return running.get(key)
    const work = (async () => {
      let failures = 0
      for (let batch = 0; batch < maxBatches; batch++) {
        let result
        try { result = await call(owner, 'unlinked_resume_investor_import', { importId, batchSize }); failures = 0 }
        catch (error) {
          // Another batch holds the lease, or a transient failure: progress is
          // durable, so wait and try again a few times. After that, or on any
          // other error, this runner stops; the status page offers to continue.
          if (['import_busy', 'upstream_unavailable', 'rate_limited'].includes(error?.code) && ++failures < 5) { await sleep(pauseMs * 4 * failures); continue }
          return
        }
        if (['complete', 'partial'].includes(result?.status)) return
        await sleep(pauseMs)
      }
    })().finally(() => running.delete(key))
    running.set(key, work)
    return work
  }
  return {
    LIST_TOOLS,
    async stage(owner, { csv, listName }) {
      if (Buffer.byteLength(csv) > LIST_UPLOAD_BYTES) throw Object.assign(new Error('list_too_large'), { code: 'list_too_large' })
      const detected = detectListMapping(csv)
      if (detected.error) throw Object.assign(new Error(detected.error), { code: detected.error })
      const staged = await call(owner, 'unlinked_stage_investor_csv', { csv, listName, mapping: detected.mapping })
      void run(owner, staged.importId)
      return { importId: staged.importId, mapping: detected.mapping, preview: staged }
    },
    status: (owner, importId, offset = 0) => call(owner, 'unlinked_get_investor_import', { importId, offset, limit: 20 }),
    resume: (owner, importId) => { void run(owner, importId) },
    running: (owner, importId) => running.has(`${owner.ownerId}\u0000${importId}`),
  }
}
