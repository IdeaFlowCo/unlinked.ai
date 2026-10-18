import { createHash, randomUUID } from 'node:crypto'
import { emailAddress, headerText } from './member-email.mjs'

// Safety reports (docs/removal-requests.md, docs/report-and-block.md): requests
// to remove an imported profile, and reports about people and messages. Each
// is stored as one `UnlinkedSafetyReport` node for the operator to review
// (mcp-server/safety-reports-operator.mjs) and, when email is configured,
// announced to the support inbox. Nothing here changes what anyone sees: the
// operator acts (for example with a `remove` profile decision).

export const SUPPORT_INBOX = 'support@ideaflow.app'
export const REPORT_KINDS = Object.freeze(['removal', 'report'])
export const REMOVAL_REASONS = Object.freeze({ about_me: 'This profile is about me', representative: 'I act for the person in this profile', other: 'Something else' })
export const REPORT_REASONS = Object.freeze({ spam: 'Spam or scam', harassment: 'Harassment or bullying', hate: 'Hate speech or threats', sexual: 'Sexual or violent content', impersonation: 'Fake profile or impersonation', other: 'Something else' })
export const TARGET_TYPES = Object.freeze(['profile', 'message', 'conversation'])
export const REPORT_STATUSES = Object.freeze(['open', 'resolved', 'dismissed'])
export const DETAILS_MAX = 2000

export class SafetyReportError extends Error {
  constructor(code) { super(code); this.name = 'SafetyReportError'; this.code = code }
}
const invalid = code => { throw new SafetyReportError(code) }
const clean = (value, max) => typeof value === 'string' ? value.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : ''
const targetId = value => typeof value === 'string' && value.length > 0 && value.length <= 480 && !/[\u0000-\u001f\u007f]/.test(value)
export const ownerHash = owner => owner?.ownerId ? createHash('sha256').update(owner.ownerId).digest('hex') : null

// One validated record from form input; throws SafetyReportError with a code the page can explain.
export function safetyReportRecord(input, { now = Date.now, id = randomUUID } = {}) {
  const kind = input?.kind
  if (!REPORT_KINDS.includes(kind)) invalid('report_kind_invalid')
  const reasons = kind === 'removal' ? REMOVAL_REASONS : REPORT_REASONS
  if (!Object.hasOwn(reasons, input.reason)) invalid('report_reason_required')
  if (!TARGET_TYPES.includes(input.targetType) || (kind === 'removal' && input.targetType !== 'profile')) invalid('report_target_invalid')
  if (!targetId(input.targetId)) invalid('report_target_invalid')
  if (typeof input.details === 'string' && input.details.length > DETAILS_MAX * 2) invalid('report_details_too_long')
  const details = clean(input.details, DETAILS_MAX)
  const contactInput = clean(input.contact, 320)
  const contact = contactInput ? emailAddress(contactInput) : null
  if (contactInput && !contact) invalid('report_contact_invalid')
  if (input.reason === 'other' && !details) invalid('report_details_required')
  const evidence = input.evidence && typeof input.evidence === 'object' ? JSON.stringify(input.evidence).slice(0, 8000) : null
  return {
    id: id(), kind, status: 'open', createdAt: now(),
    targetType: input.targetType, targetId: input.targetId, targetName: clean(input.targetName, 200) || null,
    targetPresence: ['member', 'legacy', 'shadow'].includes(input.targetPresence) ? input.targetPresence : null,
    reason: input.reason, details: details || null, contact,
    reporterOwnerHash: typeof input.reporterOwnerHash === 'string' && /^[a-f0-9]{64}$/.test(input.reporterOwnerHash) ? input.reporterOwnerHash : null,
    reporterLabel: clean(input.reporterLabel, 320) || null,
    evidence,
  }
}

const view = record => record ? Object.freeze({ ...record }) : null
const listValue = (records, { status = 'open', limit = 50 } = {}) => {
  if (status !== 'all' && !REPORT_STATUSES.includes(status)) invalid('report_status_invalid')
  return records.filter(value => status === 'all' || value.status === status).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).slice(0, Math.max(1, Math.min(500, limit))).map(view)
}

export function createMemorySafetyReportStore() {
  const records = new Map()
  return {
    async initialize() {},
    async create(record) { records.set(record.id, { ...record }); return view(record) },
    async read(id) { return view(records.get(id)) },
    async list(options) { return listValue([...records.values()], options) },
    async setStatus(id, { status, by, note = null, at = Date.now() }) {
      if (!['resolved', 'dismissed', 'open'].includes(status)) invalid('report_status_invalid')
      const value = records.get(id)
      if (!value) return null
      Object.assign(value, { status, decidedBy: by, decisionNote: note, decidedAt: at })
      return view(value)
    },
    // A deleted account's reports stay for safety review, without who sent them.
    async forgetReporter(hash) { for (const value of records.values()) if (value.reporterOwnerHash === hash) Object.assign(value, { reporterOwnerHash: null, reporterLabel: null, contact: null }) },
  }
}

const FIELDS = ['id', 'kind', 'status', 'createdAt', 'targetType', 'targetId', 'targetName', 'targetPresence', 'reason', 'details', 'contact', 'reporterOwnerHash', 'reporterLabel', 'evidence', 'decidedBy', 'decisionNote', 'decidedAt']
const number = value => typeof value?.toNumber === 'function' ? value.toNumber() : value
const fromNode = node => node ? Object.fromEntries(FIELDS.map(key => [key, key === 'createdAt' || key === 'decidedAt' ? number(node[key]) ?? null : node[key] ?? null])) : null

export function createNeo4jSafetyReportStore(driver, database = 'neo4j') {
  const run = async (query, params, mode = 'WRITE') => {
    const session = driver.session({ database, defaultAccessMode: mode })
    try { return await (mode === 'READ' ? session.executeRead(tx => tx.run(query, params)) : session.executeWrite(tx => tx.run(query, params))) } finally { await session.close() }
  }
  return {
    async initialize() {
      await run('CREATE CONSTRAINT unlinked_safety_report_id IF NOT EXISTS FOR (r:UnlinkedSafetyReport) REQUIRE r.id IS UNIQUE', {})
      await run('CREATE INDEX unlinked_safety_report_status IF NOT EXISTS FOR (r:UnlinkedSafetyReport) ON (r.status)', {})
    },
    async create(record) {
      await run('CREATE (r:UnlinkedSafetyReport) SET r = $record', { record: Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)) })
      return view(record)
    },
    async read(id) {
      const result = await run('MATCH (r:UnlinkedSafetyReport {id: $id}) RETURN properties(r) AS r', { id }, 'READ')
      return view(fromNode(result.records[0]?.get('r')))
    },
    async list({ status = 'open', limit = 50 } = {}) {
      if (status !== 'all' && !REPORT_STATUSES.includes(status)) invalid('report_status_invalid')
      const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
      const result = await run(`MATCH (r:UnlinkedSafetyReport) ${status === 'all' ? '' : 'WHERE r.status = $status'} RETURN properties(r) AS r ORDER BY r.createdAt DESC, r.id LIMIT toInteger($limit)`, { status, limit: bounded }, 'READ')
      return result.records.map(record => view(fromNode(record.get('r'))))
    },
    async setStatus(id, { status, by, note = null, at = Date.now() }) {
      if (!REPORT_STATUSES.includes(status)) invalid('report_status_invalid')
      const result = await run('MATCH (r:UnlinkedSafetyReport {id: $id}) SET r.status = $status, r.decidedBy = $by, r.decisionNote = $note, r.decidedAt = $at RETURN properties(r) AS r', { id, status, by, note, at })
      return view(fromNode(result.records[0]?.get('r')))
    },
    async forgetReporter(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash ?? '')) return
      await run('MATCH (r:UnlinkedSafetyReport {reporterOwnerHash: $hash}) REMOVE r.reporterOwnerHash, r.reporterLabel, r.contact', { hash })
    },
  }
}

// The support inbox hears about each new report. `transport` is the Resend
// transport from member-email.mjs; without one, reports are only stored.
export function supportReportEmail(record, { origin }) {
  const link = record.targetType === 'profile' ? `${origin}/people/${encodeURIComponent(record.targetId)}` : null
  const label = record.kind === 'removal' ? 'Removal request' : 'Report'
  const reasons = record.kind === 'removal' ? REMOVAL_REASONS : REPORT_REASONS
  const lines = [
    `${label} ${record.id}`,
    `Reason: ${reasons[record.reason] ?? record.reason}`,
    `About: ${record.targetType} ${record.targetName ? `"${record.targetName}" ` : ''}(${record.targetId})${record.targetPresence ? ` · ${record.targetPresence}` : ''}`,
    ...(link ? [`Profile: ${link}`] : []),
    `Details: ${record.details ?? '(none)'}`,
    `Contact: ${record.contact ?? '(none given)'}`,
    `From: ${record.reporterLabel ?? (record.reporterOwnerHash ? 'a signed-in member' : 'a visitor who was not signed in')}`,
    ...(record.evidence ? [`Evidence: ${record.evidence}`] : []),
    '',
    `Review: docker exec <runtime> node .../mcp-server/safety-reports-operator.mjs show ${record.id}`,
    ...(record.kind === 'removal' && link ? [`Remove: profile-decisions-operator.mjs remove ${record.targetId} <you> "removal request ${record.id}"`] : []),
  ]
  const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
  return {
    subject: headerText(`Unlinked ${label.toLowerCase()}: ${reasons[record.reason] ?? record.reason}${record.targetName ? ` · ${record.targetName}` : ''}`, 160),
    text: lines.join('\n'),
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><body style="font:15px/1.5 system-ui,sans-serif;color:#16181d">${lines.map(line => `<p style="margin:0 0 8px">${esc(line)}</p>`).join('')}</body></html>`,
  }
}

export function createSafetyReports({ store, transport = null, from = null, to = SUPPORT_INBOX, origin, now = Date.now, onError = () => {}, notifyTimeoutMs = 8000 }) {
  if (!store || ['initialize', 'create', 'read', 'list', 'setStatus', 'forgetReporter'].some(name => typeof store[name] !== 'function')) throw new Error('safety_report_store_required')
  const base = new URL(origin)
  const notifying = Boolean(transport && typeof transport.send === 'function' && typeof from === 'string' && from && emailAddress(to))
  async function notify(record) {
    if (!notifying) return false
    const content = supportReportEmail(record, { origin: base.origin })
    try {
      await Promise.race([transport.send({ from, to: emailAddress(to), ...(record.contact ? { replyTo: record.contact } : {}), ...content, idempotencyKey: `unlinked-safety-report-${record.id}` }),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), notifyTimeoutMs); timer.unref?.() })])
      return true
    } catch (error) { try { void Promise.resolve(onError({ event: 'safety_report_email_failed', code: error?.code ?? 'email_error' })).catch(() => {}) } catch { /* never fails a report */ } return false }
  }
  return {
    notifying,
    initialize: () => store.initialize(),
    // Stores first; the email never decides whether a report was received.
    async submit(input) {
      const record = safetyReportRecord(input, { now })
      await store.create(record)
      const emailed = await notify(record)
      return { id: record.id, reference: record.id.slice(0, 8).toUpperCase(), emailed }
    },
    list: options => store.list(options),
    read: id => store.read(id),
    setStatus: (id, value) => store.setStatus(id, value),
    forgetReporter: owner => { const hash = ownerHash(owner); return hash ? store.forgetReporter(hash) : undefined },
  }
}
