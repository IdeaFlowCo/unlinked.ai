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


test('leading field BOM survives literal, octal and hexadecimal COPY encodings', () => {
  const value = '\uFEFFLeading summary'
  for (const field of [value, '\\357\\273\\277Leading summary', '\\xEF\\xBB\\xBFLeading summary']) {
    assert.equal(decodeCopyField(field), value)
    const source = dump({ profiles: [{ id: 'a', user_id: null, summary: value }, { id: 'b', user_id: null }] }).replace(value, field)
    assert.equal(createLegacyPlan(source).profiles[0].about, value)
  }
})

test('nullable organizations preserve rows and provenance while non-null references must resolve', () => {
  const changes = {
    positions: [{ id: 'p-null', profile_id: 'a', company_id: null }, { id: 'p-company', profile_id: 'a', company_id: 'co' }],
    education: [{ id: 'e-null', profile_id: 'a', institution_id: null }, { id: 'e-school', profile_id: 'a', institution_id: 'school' }],
  }
  const plan = createLegacyPlan(dump(changes))
  assert.equal(plan.counts.positions, 2)
  assert.equal(plan.counts.education, 2)
  const { positions, education } = plan.profiles[0]
  assert.equal(positions.length, 2)
  assert.equal(education.length, 2)
  assert.deepEqual([positions[0].legacyId, positions[0].legacyProfileId, positions[0].legacyCompanyId, positions[0].company, positions[0].companyProvenance, positions[0].provenance], ['p-null', 'a', null, null, null, { table: 'public.positions', rowOrdinal: 1 }])
  assert.deepEqual([education[0].legacyId, education[0].legacyProfileId, education[0].legacyInstitutionId, education[0].institution, education[0].institutionProvenance, education[0].provenance], ['e-null', 'a', null, null, null, { table: 'public.education', rowOrdinal: 1 }])
  assert.deepEqual(positions[1].companyProvenance, { table: 'public.companies', rowOrdinal: 1 })
  assert.deepEqual(education[1].institutionProvenance, { table: 'public.institutions', rowOrdinal: 1 })
  for (const [table, column, organization] of [['positions', 'company_id', 'companies'], ['education', 'institution_id', 'institutions']]) {
    assert.throws(() => createLegacyPlan(dump({ ...changes, [table]: [{ ...changes[table][0], [column]: 'missing' }] })), { message: `legacy_plan_dangling_${organization}` })
    assert.throws(() => createLegacyPlan(dump({ ...changes, [table]: [{ ...changes[table][0], profile_id: 'missing' }] })), { message: 'legacy_plan_dangling_profiles' })
    assert.throws(() => createLegacyPlan(dump({ ...changes, [table]: [{ ...changes[table][0], [column]: '' }] })), { message: 'legacy_plan_id_invalid' })
  }
})

test('exported column policy rejects mutation without changing parsing', () => {
  const source = dump()
  for (const columns of Object.values(LEGACY_COLUMNS)) {
    assert.throws(() => columns.push('encrypted_password'), TypeError)
    assert.throws(() => { columns[0] = 'encrypted_password' }, TypeError)
  }
  assert.throws(() => { LEGACY_COLUMNS.profiles = [] }, TypeError)
  assert.equal(createLegacyPlan(source).profiles.length, 2)
})

test('oversized strings and byte sources fail before allocation or copying', t => {
  const source = dump()
  const sources = [source, Buffer.from(source), new Uint8Array(Buffer.from(source))]
  const originalFrom = Buffer.from
  for (const input of sources) {
    const mock = t.mock.method(Buffer, 'from', function (value, ...args) {
      if (value === input) throw new Error('source_copy_attempted')
      return originalFrom.call(this, value, ...args)
    })
    try {
      assert.throws(() => parseLegacyCopy(input, { maxBytes: Buffer.byteLength(source) - 1 }), { message: 'legacy_copy_bytes_limit' })
      assert.equal(mock.mock.callCount(), 0)
    } finally { mock.mock.restore() }
  }
  for (const input of sources) assert.equal(createLegacyPlan(input, { maxBytes: Buffer.byteLength(source) }).profiles.length, 2)
})
