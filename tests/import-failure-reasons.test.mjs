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
