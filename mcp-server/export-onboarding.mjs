// Shared export reminder timing and owner-scoped completion check.
import { createHash } from 'node:crypto'
import { ADDED_PERSON } from '../src/utils/private-import/background-job.mjs'

export const EXPORT_DELAY_MS = 48 * 60 * 60 * 1000
export const EXPORT_ORIGIN = 'https://www.unlinked.ai'
export const LINKEDIN_EXPORT_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data'
export const EXPORT_AGENT_PROMPT = `I've asked LinkedIn for a copy of my data so I can bring my network to Unlinked (www.unlinked.ai).

In 2 days, and again each day until it's done:
1. Search my email for a message from LinkedIn about my data archive being ready (subject usually mentions "data archive" or "your LinkedIn data"). Check spam too.
2. If it's there, remind me right away. The download link expires 72 hours after the email arrived, so tell me how much time is left. Download the ZIP if you can.
3. Then help me upload it at https://www.unlinked.ai/import. Don't open or paste the file's contents into our chat.
4. If nothing has arrived after 3 days, remind me to check https://www.linkedin.com/mypreferences/d/download-my-data and request it again.`

export async function hasCompletedExport(member, getBackend) {
  const backend = await getBackend(member)
  const ids = await (backend.listImportJobIds ?? backend.listImportIds)()
  for (let start = 0; start < ids.length; start += 8) {
    const rows = await Promise.all(ids.slice(start, start + 8).map(id => backend.readResource('import', id)))
    if (rows.some(row => row && !row.deleted && row.sourceOwnerId === member.ownerId && row.payload?.ownerId === member.ownerId && row.payload?.id === row.sourceId && !row.payload.kind && !row.payload.receiptOf && row.payload.origin?.kind !== ADDED_PERSON && (row.payload.status === 'indexed' || (row.payload.status === 'partial' && row.payload.counts?.failedFiles === 0 && row.payload.counts?.indexed > 0 && row.payload.counts?.rejected > 0)))) return true
  }
  return false
}
const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
export const icsEscape = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
const title = 'Upload your LinkedIn file to Unlinked'
const description = `Check LinkedIn's email and download your ZIP before the link expires (72 hours after arrival). Upload at ${EXPORT_ORIGIN}/import. Link expired? Request again: ${LINKEDIN_EXPORT_URL}`
export function exportCalendarLink(at = Date.now()) {
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${stamp(at + EXPORT_DELAY_MS)}/${stamp(at + EXPORT_DELAY_MS + 600000)}`, details: description })}`
}
// RFC 5545: UTF-8 content lines fold at 75 octets; continuation includes its space.
const fold = line => {
  let result = '', current = '', bytes = 0
  for (const character of line) {
    const size = Buffer.byteLength(character)
    if (bytes + size > 75) { result += `${current}\r\n`; current = ' '; bytes = 1 }
    current += character; bytes += size
  }
  return result + current
}
export function exportCalendarIcs(at = Date.now()) {
  const uid = createHash('sha256').update(String(at)).digest('hex')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Unlinked//Export reminder//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:${uid}@www.unlinked.ai`, `DTSTAMP:${stamp(at)}`, `DTSTART:${stamp(at + EXPORT_DELAY_MS)}`, `DTEND:${stamp(at + EXPORT_DELAY_MS + 600000)}`, `SUMMARY:${icsEscape(title)}`, `DESCRIPTION:${icsEscape(description)}`, `URL:${EXPORT_ORIGIN}/import`, 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n'
}
