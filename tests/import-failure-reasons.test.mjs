import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { parseArchive } from '../src/utils/private-import/archive.mjs'
import { emptyImportReason, importErrorMessage, importJobStatus } from '../src/utils/private-import/background-job.mjs'

const connections = Buffer.from('Notes:\n"When exporting your connection data..."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Lovelace,https://www.linkedin.com/in/ada,,ACME,Engineer,01 Jan 2020\n')
const reasonOf = (bytes, name) => emptyImportReason(parseArchive(bytes, name).sources)

test('a renamed Connections CSV uploaded on its own is read as Connections.csv', () => {
  for (const name of ['Connections_sans_email.csv', 'Connections (1).csv', 'connections-2026.csv']) {
    const [source] = parseArchive(connections, name).sources
    assert.equal(source.category, 'connections', name)
    assert.equal(source.accepted.length, 1, name)
    assert.equal(source.path, name)
  }
  assert.equal(parseArchive(connections, 'ConnectionsList.csv').sources[0].skipped, true)
  assert.equal(reasonOf(connections, 'people.csv'), 'unrecognized_file')
})

test('ZIP entries still need LinkedIn’s exact file names', async () => {
  const zip = new JSZip(); zip.file('Connections_sans_email.csv', connections)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  assert.equal(reasonOf(bytes, 'export.zip'), 'unrecognized_file')
})

test('an empty import names the specific cause', () => {
  assert.equal(reasonOf(Buffer.from('Name,Company\nAda,ACME\n'), 'Connections.csv'), 'csv_header_not_found')
  assert.equal(reasonOf(Buffer.from([0x46, 0xff, 0xfe, 0x0a]), 'Connections.csv'), 'invalid_utf8')
  assert.equal(reasonOf(Buffer.from('First Name,Last Name,URL\nAda,Lovelace,https://example.com/ada\n'), 'Connections.csv'), 'rows_rejected')
  assert.equal(reasonOf(Buffer.from('First Name,Last Name,URL\n'), 'Connections.csv'), 'no_rows')
  // Compact receipts keep only a rejected count.
  assert.equal(emptyImportReason([{ skipped: false, rejectedCount: 3 }]), 'rows_rejected')
})

test('failed imports carry a plain-language message', () => {
  const job = { id: 'x', status: 'failed', error: 'no_accepted_rows', failureReason: 'unrecognized_file', filename: 'Connections_sans_email.csv', counts: { accepted: 0, indexed: 0 } }
  assert.match(importJobStatus(job).errorMessage, /We didn’t recognize “Connections_sans_email\.csv”.*name it Connections\.csv/)
  assert.match(importErrorMessage({ ...job, failureReason: 'csv_header_not_found' }), /missing the First Name, Last Name and URL columns/)
  // Jobs saved before failureReason existed still get a useful message.
  assert.match(importErrorMessage({ ...job, failureReason: undefined }), /No people were found in “Connections_sans_email\.csv”/)
  assert.match(importErrorMessage({ error: 'archive_parse_failed', failureReason: 'invalid_zip_directory', filename: 'a.zip' }), /We couldn’t open “a\.zip”/)
  assert.match(importErrorMessage({ error: 'archive_parse_failed', failureReason: 'file_size_limit', filename: 'a.csv' }), /larger than 8 MB/)
})

// LinkedIn sometimes splits a large network into numbered Connections parts.
const part2 = Buffer.from('Grace,Hopper,https://www.linkedin.com/in/grace,grace@example.com,Navy,Admiral,02 Feb 2021\nAlan,Turing,https://www.linkedin.com/in/alan,,NPL,Researcher,03 Mar 2022\n')

test('numbered Connections parts inside a ZIP are read; other renamed entries still are not', async () => {
  const zip = new JSZip()
  zip.file('Connections.csv', connections); zip.file('Connections_2.csv', part2); zip.file('Connections (3).csv', connections)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const sources = parseArchive(bytes, 'export.zip').sources.filter(source => source.category === 'connections')
  assert.deepEqual(sources.map(source => [source.path, source.accepted.length]), [['Connections.csv', 1], ['Connections_2.csv', 2], ['Connections (3).csv', 1]])
})

test('a continuation part without its header row is read with LinkedIn’s Connections columns', () => {
  for (const name of ['Connections_2.csv', 'Connections (1).csv', 'Connections.csv']) {
    const [source] = parseArchive(part2, name).sources
    assert.equal(source.error, undefined, name)
    assert.equal(source.headerAssumed, 'linkedin-connections-v1')
    assert.deepEqual(source.accepted.map(row => row.subject), ['https://www.linkedin.com/in/grace', 'https://www.linkedin.com/in/alan'])
    assert.equal(source.accepted[0].fields['email address'], 'grace@example.com')
    assert.equal(source.accepted[1].fields['connected on'], '03 Mar 2022')
  }
  // Only rows of exactly that shape with a LinkedIn address qualify.
  assert.equal(reasonOf(Buffer.from('Grace,Hopper,https://example.com/grace,,Navy,Admiral,02 Feb 2021\n'), 'Connections_2.csv'), 'csv_header_not_found')
  assert.equal(reasonOf(Buffer.from('Grace,Hopper,https://www.linkedin.com/in/grace,Navy\n'), 'Connections_2.csv'), 'csv_header_not_found')
  assert.equal(parseArchive(part2, 'Positions.csv').sources[0].error, 'csv_header_not_found')
})

test('a full export keeps every file: unread ones are inventoried, the original stays whole, nothing large blocks it', async () => {
  const zip = new JSZip()
  zip.file('Connections.csv', connections)
  zip.file('Profile.csv', 'First Name,Last Name,Headline\nAda,Lovelace,Engineer\n')
  zip.file('messages.csv', 'CONVERSATION ID,FROM,TO,CONTENT\n' + 'c1,Ada,Grace,"private words"\n'.repeat(400000))
  zip.file('PhoneNumbers.csv', 'Extension,Number,Type\n,+1 555 0100,Mobile\n')
  zip.file('Email Addresses.csv', 'Email Address,Confirmed,Primary\nada@example.com,Yes,Yes\n')
  zip.file('Jobs/Job Applications.csv', 'Application Date,Company Name\n01/01/26,ACME\n')
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const parsed = parseArchive(bytes, 'Complete_LinkedInDataExport_11-05-2026.zip')
  const manifest = parsed.sources.find(source => source.path === '__archive_manifest__/ignored-entries.json')
  const entries = JSON.parse(manifest.rawBytes).entries.map(entry => entry.path).sort()
  assert.deepEqual(entries, ['Email Addresses.csv', 'Jobs/Job Applications.csv', 'PhoneNumbers.csv', 'messages.csv'])
  assert.ok(JSON.parse(manifest.rawBytes).entries.find(entry => entry.path === 'messages.csv').expandedBytes > 8 * 1024 * 1024)
  // Unread files never become observations, so nothing reads them but the owner's original.
  const categories = new Set(parsed.sources.flatMap(source => source.accepted.map(row => row.category)))
  assert.deepEqual([...categories].sort(), ['connections', 'profile'])
  assert.doesNotMatch(JSON.stringify(parsed.sources.map(source => ({ ...source, rawBytes: undefined }))), /private words|555 0100|ada@example\.com/)
})

test('public profiles built from a split Connections part never carry its private columns', async () => {
  const { projectPublicMemberImport } = await import('../src/utils/public-people/member-projection.mjs')
  const { PUBLIC_UPLOAD_CONSENT } = await import('../src/utils/private-import/consent.mjs')
  const [source] = parseArchive(part2, 'Connections_2.csv').sources
  const id = 'a'.repeat(64)
  const assertions = source.accepted.map((row, index) => ({ ...row, id: String(index).repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'b'), importId: id, ownerId: 'owner' }))
  const job = { id, ownerId: 'owner', archiveSha256: 'c'.repeat(64), status: 'indexed', consent: PUBLIC_UPLOAD_CONSENT, counts: { accepted: assertions.length, indexed: assertions.length } }
  for (const includeDetails of [false, true]) {
    const projection = JSON.stringify(projectPublicMemberImport({ job, assertions, includeDetails }))
    assert.match(projection, /Grace Hopper/)
    assert.doesNotMatch(projection, /grace@example\.com|02 Feb 2021/)
  }
})
