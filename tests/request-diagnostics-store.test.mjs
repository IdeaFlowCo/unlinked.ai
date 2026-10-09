import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, link, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDiagnosticsStore } from '../mcp-server/request-diagnostics-store.mjs'
import { readDiagnostics } from '../scripts/read-request-diagnostics.mjs'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
const privateText = 'PRIVATE-QUERY-TOKEN-NAME'
const row = () => ({ schema: 1, event: 'agent_request', request_id: randomUUID(), at: '2026-10-09T00:00:00.000Z', transport: 'rest', route: '/api/agent/v1/whoami', auth_outcome: 'rejected', account_id: 'a'.repeat(64), body: privateText, query: privateText, authorization: privateText, error_class: privateText, tool: privateText })
async function directory(t) { const path = await mkdtemp(join(process.cwd(), '.diagnostics-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path }

test('private store re-projects records, bounds queue/size, reports drops, and retains seven UTC dates', async t => {
 const dir = await directory(t); let date = new Date('2026-10-09T00:00:00Z')
 await writeFile(join(dir, 'requests-2026-10-02.jsonl'), 'old', { mode: 0o600 })
 await writeFile(join(dir, 'requests-2026-10-03.jsonl'), 'retained', { mode: 0o600 })
 await writeFile(join(dir, 'unrelated.txt'), 'preserve', { mode: 0o600 })
 const sink = await createDiagnosticsStore({ directory: dir, now: () => date, maxQueue: 1, maxBytes: 1024 }); t.after(() => sink.close())
 assert.ok(!(await readdir(dir)).includes('requests-2026-10-02.jsonl'))
 sink.emit(row()); sink.emit(row()); await sink.flush()
 let file = join(dir, 'requests-2026-10-09.jsonl'), text = await readFile(file, 'utf8'), saved = JSON.parse(text)
 assert.equal(saved.sink_dropped_since_last_write, 1); assert.equal(saved.account_id, undefined); assert.ok(!text.includes(privateText)); assert.equal((await stat(file)).mode & 0o777, 0o600)
 for (let i = 0; i < 10; i++) { sink.emit(row()); await sink.flush() }
 assert.ok((await stat(file)).size <= 1024); assert.ok(sink.stats().dropped > 1)
 date = new Date('2026-10-10T00:00:00Z'); sink.emit(row()); await sink.flush()
 assert.ok(!(await readdir(dir)).includes('requests-2026-10-03.jsonl')); assert.equal(await readFile(join(dir, 'unrelated.txt'), 'utf8'), 'preserve')
 saved = JSON.parse(await readFile(join(dir, 'requests-2026-10-10.jsonl'), 'utf8')); assert.ok(saved.sink_dropped_since_last_write > 0)
 await sink.close(); const count = sink.stats().written; sink.emit(row()); assert.equal(sink.stats().written, count)
})

test('store refuses non-private directories and never follows symlinks or appends to hard-linked files', async t => {
 const root = await directory(t), target = join(root, 'original'), linkpath = join(root, 'requests-2026-10-09.jsonl')
 await writeFile(target, 'KEEP', { mode: 0o600 }); await symlink(target, linkpath)
 const sink = await createDiagnosticsStore({ directory: root, now: () => new Date('2026-10-09') }); t.after(() => sink.close())
 sink.emit(row()); await sink.flush(); assert.equal(await readFile(target, 'utf8'), 'KEEP'); assert.equal(sink.stats().failures, 1)
 await rm(linkpath); await link(target, linkpath); sink.emit(row()); await sink.flush(); assert.equal(await readFile(target, 'utf8'), 'KEEP'); assert.equal(sink.stats().failures, 2)
 await rm(linkpath); await writeFile(linkpath, '', { mode: 0o644 }); sink.emit(row()); await sink.flush(); assert.equal((await stat(linkpath)).size, 0)
 await chmod(root, 0o755); await assert.rejects(createDiagnosticsStore({ directory: root }), /not_private/)
 const alias = root + '-alias'; await symlink(root, alias); t.after(() => rm(alias)); await assert.rejects(createDiagnosticsStore({ directory: alias }), /not_private/)
})

test('schema projection rejects arbitrary IDs, paths, methods, timestamps and nested payloads', () => {
 assert.equal(safeDiagnosticRecord({ ...row(), request_id: privateText }), null)
 const value = safeDiagnosticRecord({ ...row(), method: privateText, route: '/api/agent/v1/people/' + privateText, at: privateText, result_count: -1, requested_timeout_ms: Infinity, headers: { Authorization: privateText }, truncated: privateText })
 assert.ok(!JSON.stringify(value).includes(privateText)); assert.equal(value.result_count, undefined)
})

test('operator reader requires exact filters and re-projects persisted rows without exposing foreign fields', async t => {
 const dir = await directory(t), one = row(), two = row(), file = join(dir, 'requests-2026-10-09.jsonl')
 await writeFile(file, [JSON.stringify(one), JSON.stringify(two), 'corrupt'].join('\n'), { mode: 0o600 })
 const result = await readDiagnostics({ directory: dir, requestId: one.request_id, since: '2026-10-09T00:00:00Z' })
 assert.equal(result.records.length, 1); assert.equal(result.records[0].request_id, one.request_id); assert.ok(!JSON.stringify(result).includes(privateText))
 assert.equal((await readDiagnostics({ directory: dir, requestId: one.request_id, since: '2026-10-10T00:00:00Z' })).records.length, 0)
 await assert.rejects(readDiagnostics({ directory: dir }), /filter_required/)
 await assert.rejects(readDiagnostics({ directory: dir, requestId: '../../secret' }), /filter_required/)
})

test('backwards clock drops new date files instead of growing the retention capacity', async t => {
 const dir = await directory(t); let now = new Date('2026-10-09')
 const sink = await createDiagnosticsStore({ directory: dir, now: () => now, retentionDays: 1 }); t.after(() => sink.close())
 sink.emit(row()); await sink.flush(); now = new Date('2026-10-08'); sink.emit(row()); await sink.flush()
 assert.deepEqual(await readdir(dir), ['requests-2026-10-09.jsonl']); assert.equal(sink.stats().dropped, 1)
})


test('persisted batch records and operator reads suppress ambiguous call fields', async t => {
 const dir = await directory(t)
 const sink = await createDiagnosticsStore({ directory: dir, now: () => new Date('2026-10-09') }); t.after(() => sink.close())
 const batch = { ...row(), transport: 'direct_mcp', route: '/mcp', rpc_batch: true, rpc_message_count: 2, http_status: 200,
   tool: 'unlinked_whoami', rpc_method: 'tools/call', result_count: 17, error_class: 'upstream_unavailable', failure_stage: 'provider_http', timed_out: true, rate_limited: true, query_chars: 12, cancelled: false }
 sink.emit(batch); await sink.flush()
 const persisted = JSON.parse(await readFile(join(dir, 'requests-2026-10-09.jsonl'), 'utf8'))
 const result = await readDiagnostics({ directory: dir, requestId: batch.request_id })
 for (const record of [persisted, result.records[0]]) {
   assert.equal(record.rpc_batch, true); assert.equal(record.rpc_message_count, 2); assert.equal(record.http_status, 200)
   assert.equal(record.cancelled, false)
   for (const field of ['tool', 'rpc_method', 'result_count', 'error_class', 'failure_stage', 'timed_out', 'rate_limited', 'query_chars']) assert.equal(Object.hasOwn(record, field), false, field)
   assert.ok(!JSON.stringify(record).includes(privateText))
 }
})
