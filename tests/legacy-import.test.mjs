import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LEGACY_COLUMNS, decodeCopyField, parseLegacyCopy } from '../src/utils/legacy-import/postgres-copy.mjs'
import { createLegacyPlan } from '../src/utils/legacy-import/legacy-plan.mjs'

const encode = value => value === null || value === undefined ? '\\N' : String(value).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
function dump(changes = {}) {
  const rows = { companies: [{ id: 'co', name: 'Example' }], institutions: [{ id: 'school', name: 'College' }], profiles: [{ id: 'a', user_id: 'unresolved-auth-id', full_name: 'Synthetic A', summary: 'Line one\nLine two\t\\N' }, { id: 'b', user_id: null, full_name: 'Synthetic B' }], connections: [{ id: 'edge', profile_id_a: 'a', profile_id_b: 'b' }], positions: [{ id: 'position', profile_id: 'a', company_id: 'co', title: 'Researcher' }], education: [{ id: 'education', profile_id: 'a', institution_id: 'school', degree_name: 'Design' }], skills: [{ id: 'skill', profile_id: 'a', name: 'Research' }], uploads: [{ id: 'upload', profile_id: 'a', file_name: 'synthetic.zip', file_path: 'safe/synthetic.zip' }], ...changes }
  return 'SELECT never_execute_this();\nCOPY auth.users (id, encrypted_password) FROM stdin;\nsecret\tpassword-secret\n\\.\n' + Object.entries(LEGACY_COLUMNS).map(([table, columns]) => `COPY public.${table} (${columns.join(', ')}) FROM stdin;\n${rows[table].map(row => columns.map(column => encode(row[column])).join('\t') + '\n').join('')}\\.\n`).join('')
}

test('normalizes all source IDs, directed endpoints, related entities and provenance without secrets or ownership inference', () => {
  const source = dump(), containerHash = createHash('sha256').update('synthetic-container').digest('hex'), plan = createLegacyPlan(source, { sourceContainerSha256: containerHash })
  assert.equal(plan.sourceContainerSha256, containerHash)
  assert.throws(() => createLegacyPlan(source, { sourceContainerSha256: 'bad-hash' }), /container_hash_invalid/)
  assert.equal(plan.sourceSha256, createHash('sha256').update(source).digest('hex'))
  assert.deepEqual(plan.counts, { companies: 1, institutions: 1, connections: 1, education: 1, positions: 1, profiles: 2, skills: 1, uploads: 1 })
  assert.equal(plan.profiles[0].legacyUserId, 'unresolved-auth-id')
  assert.equal(plan.profiles[1].legacyUserId, null)
  assert.equal(plan.profiles[0].about, 'Line one\nLine two\t\\N')
  assert.equal(plan.profiles[0].positions[0].legacyCompanyId, 'co')
  assert.equal(plan.profiles[0].education[0].legacyInstitutionId, 'school')
  assert.equal(plan.profiles[0].skills[0].legacyId, 'skill')
  assert.deepEqual(plan.connections.map(row => [row.fromLegacyProfileId, row.toLegacyProfileId]), [['a', 'b']])
  assert.deepEqual(plan.connections[0].provenance, { table: 'public.connections', rowOrdinal: 1 })
  assert.equal(plan.uploads[0].filePath, 'safe/synthetic.zip')
  assert.equal(plan.companies[0].legacyId, 'co')
  assert.deepEqual(plan.issues, [])
  assert.doesNotMatch(JSON.stringify(plan), /password-secret|encrypted_password|ownerId|verifiedEmail/)
})

test('COPY null, control, slash, hex, octal and multibyte UTF8 escapes decode exactly', () => {
  assert.equal(decodeCopyField('\\N'), null)
  assert.equal(decodeCopyField('\\\\N'), '\\N')
  assert.equal(decodeCopyField('a\\tb\\nc\\r\\b\\f\\v\\\\'), 'a\tb\nc\r\b\f\v\\')
  assert.equal(decodeCopyField('caf\\303\\251 / \\xC3\\xA9'), 'café / é')
  assert.equal(decodeCopyField('\\q'), 'q')
  assert.throws(() => decodeCopyField('trailing\\'), /escape_incomplete/)
  assert.throws(() => decodeCopyField('\\x'), /hex_invalid/)
  assert.throws(() => decodeCopyField('\\000'), /nul_invalid/)
  assert.throws(() => decodeCopyField('\\377'), /utf8_invalid/)
})

test('quoted names and reordered columns follow the header, not presumed column order', () => {
  const source = dump().replace('COPY public.companies (id, name, created_at)', 'COPY "public"."companies" (name, "id", created_at)').replace('co\tExample\t\\N', 'Example\tco\t\\N')
  assert.equal(createLegacyPlan(source).companies[0].name, 'Example')
})

test('duplicates and conflicting identities fail closed rather than truncate', () => {
  assert.throws(() => createLegacyPlan(dump({ profiles: [{ id: 'a', user_id: null }, { id: 'a', user_id: 'different' }] })), /duplicate_profiles/)
  assert.throws(() => createLegacyPlan(dump({ connections: [{ id: 'one', profile_id_a: 'a', profile_id_b: 'b' }, { id: 'two', profile_id_a: 'a', profile_id_b: 'b' }] })), /duplicate_directed_edge/)
  const source = dump();assert.throws(() => parseLegacyCopy(source + source), /table_duplicate/)
})

test('every whitelisted relational reference must resolve', () => {
  for (const [table, row] of Object.entries({ connections: { id: 'edge', profile_id_a: 'a', profile_id_b: 'missing' }, positions: { id: 'p', profile_id: 'a', company_id: 'missing' }, education: { id: 'e', profile_id: 'missing', institution_id: 'school' }, skills: { id: 's', profile_id: 'missing' }, uploads: { id: 'u', profile_id: 'missing' } })) assert.throws(() => createLegacyPlan(dump({ [table]: [row] })), /dangling_/)
})

test('bounds and malformed/truncated COPY are rejected without data-bearing errors', () => {
  const source = dump()
  for (const limits of [{ maxBytes: 1 }, { maxLineBytes: 1 }, { maxRowsPerTable: 1 }, { maxCopySections: 1 }]) assert.throws(() => parseLegacyCopy(source, limits), /limit/)
  assert.throws(() => parseLegacyCopy(source, { maxBytes: Infinity }), /bound_invalid/)
  assert.throws(() => parseLegacyCopy(source.slice(0, -3)), /unterminated/)
  assert.throws(() => parseLegacyCopy(source.replace('co\tExample\t\\N', 'co\tExample')), /width_invalid/)
  assert.throws(() => parseLegacyCopy(source.replace('id, name, created_at', 'id, encrypted_password, created_at')), /columns_invalid/)
  assert.throws(() => parseLegacyCopy(Buffer.from([0xff])), /utf8_invalid/)
})
