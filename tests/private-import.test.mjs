import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import Papa from 'papaparse'
import { parseArchive, parseSource, unpackArchive, LIMITS } from '../src/utils/private-import/archive.mjs'
import { ingestArchive } from '../src/utils/private-import/job.mjs'
import { isolatedStore } from './private-import-store.mjs'

const header = 'First Name,Last Name,URL,Company,Position\r\n'
const contact = (company = 'Synthetic Alpha') => `Ada,Example,https://www.linkedin.com/in/synthetic-ada,${company},Engineer\r\n`
async function archive(files) {
  const zip = new JSZip()
  for (const [path, bytes] of Object.entries(files)) zip.file(path, bytes)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'unlinked-private-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, adapter: isolatedStore(root, options) }
}

test('real ZIP and CSV bytes discover variable preambles and preserve rejected/unknown sources', async () => {
  const bytes = await archive({
    'archive/Connections.csv': 'Notes:\r\nYour exported connections, including fields\r\n\r\n' + header + contact() + 'Missing,Url,,Example,Designer\r\n',
    'Skills.csv': 'Name\n"Synthetic, skill"\n',
    'Unknown.csv': 'raw,unknown\nkeep,me\n',
  })
  const parsed = parseArchive(bytes, 'archive.zip')
  assert.equal(parsed.sources[0].accepted.length, 1)
  assert.equal(parsed.sources[0].rejected.length, 1)
  assert.equal(parsed.sources[0].rejected[0].reason, 'missing_required_field')
  assert.equal(parsed.sources[1].accepted[0].fields.name, 'Synthetic, skill')
  assert.equal(parsed.sources[2].skipped, true)
  assert.equal(parsed.sources[2].rawBytes.toString(), 'raw,unknown\nkeep,me\n')
  assert.equal(parseArchive(Buffer.from(header + contact()), 'Connections.csv').sources[0].accepted.length, 1)
})

test('missing header, malformed rows, invalid UTF8 and foreign URLs are explicit failures', () => {
  const source = text => parseArchive(Buffer.from(text), 'Connections.csv').sources[0]
  assert.equal(source('not a header').error, 'csv_header_not_found')
  assert.equal(source(header + 'Ada,Example,https://evil.test/in/synthetic-ada,Example,Engineer\n').rejected[0].reason, 'invalid_or_missing_linkedin_url')
  assert.equal(source(header + 'Ada,Example,https://www.linkedin.com/in/synthetic-ada,Example\n').rejected[0].reason, 'csv_column_count')
  assert.equal(source(header + '"unterminated').accepted.length, 0)
  assert.equal(parseArchive(Buffer.from([0xff]), 'Skills.csv').sources[0].error, 'invalid_utf8')
  assert.equal(source(Array(21).fill('preamble').join('\n') + '\n' + header + contact()).error, 'csv_header_not_found')
})

test('bounded ZIP expansion rejects lying sizes, corrupt bytes, duplicate and unsafe paths', async () => {
  const bomb = await archive({ 'Unknown.csv': '0'.repeat(LIMITS.fileBytes + 1) })
  assert.throws(() => unpackArchive(bomb, 'archive.zip'), /zip_expansion_limit/)
  const lying = Buffer.from(bomb)
  const directory = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  lying.writeUInt32LE(1, directory + 24)
  assert.throws(() => unpackArchive(lying, 'archive.zip')) // actual inflate bound
  const unsafe = await archive({ '../escape.csv': 'no' })
  assert.throws(() => unpackArchive(unsafe, 'archive.zip'), /unsafe_archive_path/)
  const normal = await archive({ 'Connections.csv': header + contact() })
  const corrupt = Buffer.from(normal)
  corrupt[corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16] ^= 1
  assert.throws(() => unpackArchive(corrupt, 'archive.zip'), /zip_content_mismatch/)
  assert.throws(() => unpackArchive(Buffer.from('garbage'), 'archive.zip'), /invalid_zip_directory/)
  assert.throws(() => unpackArchive(Buffer.alloc(LIMITS.archiveBytes + 1), 'archive.zip'), /archive_size_limit/)
})

test('durable replay and simultaneous duplicate uploads preserve immutable private sources', async t => {
  const { root, adapter } = await fixture(t)
  const bytes = await archive({ 'Connections.csv': header + contact(), 'Other.txt': 'retained privately' })
  const request = { ownerId: 'synthetic-owner-a', filename: 'archive.zip', bytes, adapter }
  const [first, duplicate] = await Promise.all([ingestArchive(request), ingestArchive(request)])
  assert.deepEqual(duplicate, first)
  assert.equal(first.status, 'partial')
  assert.equal(first.phase, 'awaiting_private_index')
  assert.equal(first.counts.indexed, 0)
  assert.equal(first.counts.accepted, 1)
  assert.equal(first.counts.skippedFiles, 1)
  assert.equal((await adapter.assertions(request.ownerId)).length, 1)
  const reopened = isolatedStore(root)
  assert.deepEqual(await ingestArchive({ ...request, adapter: reopened }), first)
  assert.deepEqual(await reopened.asset(request.ownerId, first.archiveSha256), bytes)
  assert.equal((await stat(root)).mode & 0o077, 0)
})

test('two owners with the same subject retain conflicting assertions and cannot read each other by ID/hash', async t => {
  const { root, adapter } = await fixture(t)
  const a = await ingestArchive({ ownerId: 'synthetic-owner-a', filename: 'Connections.csv', bytes: Buffer.from(header + contact('Alpha')), adapter })
  const b = await ingestArchive({ ownerId: 'synthetic-owner-b', filename: 'Connections.csv', bytes: Buffer.from(header + contact('Beta')), adapter })
  assert.notEqual(a.id, b.id)
  assert.equal(await adapter.job('synthetic-owner-b', a.id), null)
  assert.equal(await adapter.asset('synthetic-owner-b', a.archiveSha256), null)
  assert.equal((await adapter.assertions('synthetic-owner-a'))[0].fields.company, 'Alpha')
  assert.equal((await adapter.assertions('synthetic-owner-b'))[0].fields.company, 'Beta')
  assert.equal((await isolatedStore(root).assertions('anonymous')).length, 0)
  // Source files are immutable history; a revised archive never overwrites an
  // old assertion or the other owner's conflicting observation.
  await ingestArchive({ ownerId: 'synthetic-owner-a', filename: 'Connections.csv', bytes: Buffer.from(header + contact('Revised')), adapter })
  assert.equal((await adapter.assertions('synthetic-owner-a')).length, 2)
  assert.equal((await adapter.assertions('synthetic-owner-b')).length, 1)
  assert.equal((await adapter.job('synthetic-owner-a', a.id)).counts.accepted, 1)
})

test('parser failure leaves a durable failed job and recoverable original bytes', async t => {
  const { adapter } = await fixture(t)
  const bytes = Buffer.from('not a zip')
  const job = await ingestArchive({ ownerId: 'synthetic-owner-a', filename: 'archive.zip', bytes, adapter })
  assert.equal(job.status, 'failed')
  assert.equal(job.counts.indexed, 0)
  assert.equal(job.error, 'archive_parse_failed')
  assert.deepEqual(await adapter.asset('synthetic-owner-a', job.archiveSha256), bytes)
})

test('interrupted publication exposes no partial assertions and retries from durable parsing', async t => {
  let interrupt = true
  const { root, adapter } = await fixture(t, { beforePublish: async () => { if (interrupt) throw new Error('synthetic_io_failure') } })
  const request = { ownerId: 'synthetic-owner-a', filename: 'Connections.csv', bytes: Buffer.from(header + contact()), adapter }
  await assert.rejects(ingestArchive(request), /synthetic_io_failure/)
  assert.equal((await adapter.assertions(request.ownerId)).length, 0)
  const reopened = isolatedStore(root)
  interrupt = false
  const job = await ingestArchive({ ...request, adapter: reopened })
  assert.equal(job.counts.accepted, 1)
  assert.equal((await reopened.assertions(request.ownerId)).length, 1)
  assert.equal(job.status, 'partial')
})


test('CSV filenames select independent replay identities and immutable category assertions', async t => {
  const { adapter } = await fixture(t)
  const ownerId = 'synthetic-owner-a'
  const bytes = Buffer.from(header + contact())
  const upload = filename => ingestArchive({ ownerId, filename, bytes, adapter })
  const unknown = await upload('Unknown.csv')
  const connections = await upload('Connections.csv')
  const profile = await upload('Profile.csv')
  assert.equal(unknown.status, 'failed')
  assert.equal(unknown.counts.skippedFiles, 1)
  assert.equal(connections.counts.accepted, 1)
  assert.equal(profile.counts.accepted, 1)
  assert.equal(new Set([unknown.id, connections.id, profile.id]).size, 3)
  assert.deepEqual(await upload('Connections.csv'), connections)
  assert.deepEqual(await upload('Profile.csv'), profile)
  assert.deepEqual(await adapter.job(ownerId, unknown.id), unknown)
  const assertions = await adapter.assertions(ownerId)
  assert.deepEqual(assertions.map(row => row.category).sort(), ['connections', 'profile'])
  assert.equal(new Set(assertions.map(row => row.id)).size, 2)
  assert.ok(assertions.every(row => row.ownerId === ownerId && row.visibility === 'owner'))
  assert.deepEqual(await adapter.asset(ownerId, connections.archiveSha256), bytes)
})

test('blank records preserve quote errors on the malformed record before a valid skill', () => {
  const bytes = Buffer.from('Name\n\n"Malformed"x"\nValid skill\n')
  const source = parseArchive(bytes, 'Skills.csv').sources[0]
  assert.deepEqual(source.rejected, [{ rowId: 'Skills.csv#record=2', reason: 'InvalidQuotes' }])
  assert.equal(source.accepted.length, 1)
  assert.equal(source.accepted[0].fields.name, 'Valid skill')
  assert.equal(source.accepted[0].rowId, 'Skills.csv#record=3')
  assert.deepEqual(source.rawBytes, bytes)
})

test('incremental parsing aborts dense input and shares a budget across archive members', async () => {
  const bytes = await archive({
    'Skills.csv': 'Name\n' + 'a\n'.repeat(60000),
    'nested/Skills.csv': 'Name\n' + 'b\n'.repeat(60000),
  })
  const originalParse = Papa.parse
  let steps = 0, aborted = 0
  Papa.parse = (input, config) => originalParse(input, {
    ...config,
    step: config.step && ((result, parser) => {
      steps++
      config.step(result, parser)
    }),
    complete(result) {
      aborted += Number(Boolean(result.meta.aborted))
      config.complete?.(result)
    },
  })
  try {
    const source = parseSource({ path: 'Skills.csv', bytes: Buffer.from('Name\n' + 'a\n'.repeat(4000000)) })
    assert.equal(source.error, 'csv_row_limit')
    assert.equal(source.accepted.length, 0)
    assert.equal(steps, LIMITS.rows + 1)
    assert.equal(aborted, 1)
    steps = 0; aborted = 0
    assert.throws(() => parseArchive(bytes, 'archive.zip'), /archive_row_limit/)
    assert.equal(steps, LIMITS.rows + 1)
    assert.equal(aborted, 1)
    steps = 0; aborted = 0
    const blanks = parseSource({ path: 'Skills.csv', bytes: Buffer.from('Name\n' + '\n'.repeat(LIMITS.rows + 10)) })
    assert.equal(blanks.error, 'csv_row_limit')
    assert.equal(steps, LIMITS.rows + 1)
    assert.equal(aborted, 1)
  } finally { Papa.parse = originalParse }
})

test('failed-file totals agree with statuses for invalid, header-only and mixed sources', async t => {
  const { adapter } = await fixture(t)
  const ownerId = 'synthetic-owner-a'
  for (const bytes of [Buffer.from(header), Buffer.from(header + 'Ada,Example,https://evil.test/in/ada,Example,Engineer\n')]) {
    const job = await ingestArchive({ ownerId, filename: 'Connections.csv', bytes, adapter })
    assert.equal(job.status, 'failed')
    assert.equal(job.sources[0].status, 'failed')
    assert.equal(job.counts.failedFiles, 1)
    assert.equal(job.counts.indexed, 0)
  }
  const bytes = await archive({
    'Connections.csv': header,
    'Skills.csv': 'Name\nValid skill\n',
    'Profile.csv': 'not a header',
    'Unknown.csv': 'unknown bytes',
  })
  const job = await ingestArchive({ ownerId, filename: 'archive.zip', bytes, adapter })
  assert.equal(job.status, 'partial')
  assert.equal(job.counts.failedFiles, 2)
  assert.equal(job.counts.failedFiles, job.sources.filter(source => source.status === 'failed').length)
  assert.equal(job.counts.skippedFiles, 1)
  assert.equal(job.counts.accepted, 1)
  assert.equal(job.counts.indexed, 0)
})
