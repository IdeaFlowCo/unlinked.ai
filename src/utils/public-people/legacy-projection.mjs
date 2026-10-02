// Pure projection of the approved public-table legacy plan; never reads or writes a backend.
export const LEGACY_PUBLIC_TRANSFORM_VERSION = 'legacy-public-v1'
const TABLES = ['profiles', 'connections', 'positions', 'education', 'skills', 'companies', 'institutions', 'uploads']
const fail = code => { throw new Error(`legacy_public_${code}`) }
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const record = value => {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('record_invalid')
  return value
}
const array = (value, max) => {
  if (!Array.isArray(value) || value.length > max) fail('array_limit_or_invalid')
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('array_invalid')
  }
  return value
}
const id = value => { if (typeof value !== 'string' || !value.trim() || value.length > 160 || value === '.' || value === '..') fail('id_invalid'); return value }
const nullableId = value => value === null ? null : id(value)
const nullableText = value => { if (value !== null && typeof value !== 'string') fail('text_invalid'); return value }
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('source_hash_invalid'); return value }
const sort = rows => rows.sort((a, b) => a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0)
const freeze = value => {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

/** Returns a reader-ready immutable snapshot and a separate, non-reader provenance manifest. */
export function createLegacyPublicProjection(plan, { maxProfiles = 20000, maxConnections = 100000, maxTextBytes = 16 * 1024 * 1024 } = {}) {
  for (const [bound, maximum] of [[maxProfiles, 20000], [maxConnections, 100000], [maxTextBytes, 16 * 1024 * 1024]]) if (!Number.isSafeInteger(bound) || bound < 1 || bound > maximum) fail('bound_invalid')
  record(plan)
  const sourceSha256 = hash(plan.sourceSha256)
  const sourceContainerSha256 = plan.sourceContainerSha256 === null ? null : hash(plan.sourceContainerSha256)
  if (array(plan.issues, 0).length !== 0) fail('plan_incomplete')
  const counts = record(plan.counts), rows = Object.fromEntries(TABLES.map(table => [table, new Set()]))
  for (const table of TABLES) if (!Number.isSafeInteger(counts[table]) || counts[table] < 0 || counts[table] > 1000000) fail('counts_invalid')
  let textBytes = 0
  const text = (value, { required = false, name = false } = {}) => {
    nullableText(value)
    if (value === null && !required) return undefined
    const result = value ?? ''
    if (result.length > 20000 || (name && !result.trim())) fail('text_invalid')
    textBytes += Buffer.byteLength(result)
    if (textBytes > maxTextBytes) fail('text_limit')
    return result
  }
  const optional = (output, key, value) => { const result = text(value); if (result !== undefined) output[key] = result }
  const provenance = (value, table) => {
    record(value)
    if (value.table !== `public.${table}` || !Number.isSafeInteger(value.rowOrdinal) || value.rowOrdinal < 1 || value.rowOrdinal > counts[table]) fail('provenance_invalid')
    return { table: value.table, rowOrdinal: value.rowOrdinal }
  }
  const identities = Object.fromEntries(TABLES.map(table => [table, new Set()]))
  const sourceRow = (value, table) => {
    record(value)
    const legacyId = id(value.legacyId), origin = provenance(value.provenance, table)
    if (identities[table].has(legacyId) || rows[table].has(origin.rowOrdinal)) fail('duplicate_id_or_provenance')
    identities[table].add(legacyId); rows[table].add(origin.rowOrdinal)
    return { legacyId, provenance: origin }
  }
  const organization = table => sort(array(plan[table], 1000000).map(value => ({ ...sourceRow(value, table), name: nullableText(value.name), createdAt: nullableText(value.createdAt) })))
  const companies = organization('companies'), institutions = organization('institutions')
  const companyById = new Map(companies.map(value => [value.legacyId, value])), institutionById = new Map(institutions.map(value => [value.legacyId, value]))
  const related = (value, table, referenceKey, nameKey, provenanceKey, index) => {
    const legacyId = nullableId(value[referenceKey]), name = nullableText(value[nameKey])
    if (legacyId === null) {
      if (name !== null || value[provenanceKey] !== null) fail('organization_invalid')
      return { [referenceKey]: null, [nameKey]: null, [provenanceKey]: null }
    }
    const target = index.get(legacyId), origin = provenance(value[provenanceKey], table)
    if (!target || target.name !== name || target.provenance.rowOrdinal !== origin.rowOrdinal) fail('organization_invalid')
    return { [referenceKey]: legacyId, [nameKey]: name, [provenanceKey]: origin }
  }
  const profiles = [], profileManifest = []
  for (const value of array(plan.profiles, maxProfiles)) {
    const mapping = sourceRow(value, 'profiles')
    const output = { id: mapping.legacyId, name: text(value.name, { required: true, name: true }), positions: [], education: [], skills: [] }
    optional(output, 'headline', value.headline); optional(output, 'about', value.about)
    Object.assign(mapping, { legacyUserId: nullableId(value.legacyUserId), linkedinSlug: nullableText(value.linkedinSlug), industry: nullableText(value.industry), createdAt: nullableText(value.createdAt), updatedAt: nullableText(value.updatedAt), positions: [], education: [], skills: [] })
    const nested = (entry, table) => {
      const result = sourceRow(entry, table)
      if (entry.legacyProfileId !== mapping.legacyId) fail('dangling_profile')
      return { ...result, legacyProfileId: mapping.legacyId, createdAt: nullableText(entry.createdAt) }
    }
    for (const position of array(value.positions, 100)) {
      const entry = { ...nested(position, 'positions'), ...related(position, 'companies', 'legacyCompanyId', 'company', 'companyProvenance', companyById), title: nullableText(position.title), startedOn: nullableText(position.startedOn), finishedOn: nullableText(position.finishedOn) }
      const dto = { title: text(position.title, { required: true }), company: text(position.company, { required: true }) }
      optional(dto, 'startDate', position.startedOn); optional(dto, 'endDate', position.finishedOn); optional(dto, 'description', position.description)
      mapping.positions.push(entry); output.positions.push(dto)
    }
    for (const education of array(value.education, 100)) {
      const entry = { ...nested(education, 'education'), ...related(education, 'institutions', 'legacyInstitutionId', 'institution', 'institutionProvenance', institutionById), degree: nullableText(education.degree), startedOn: nullableText(education.startedOn), finishedOn: nullableText(education.finishedOn) }
      const dto = { institution: text(education.institution, { required: true }) }
      optional(dto, 'degree', education.degree); optional(dto, 'startDate', education.startedOn); optional(dto, 'endDate', education.finishedOn)
      mapping.education.push(entry); output.education.push(dto)
    }
    for (const skill of array(value.skills, 500)) { mapping.skills.push({ ...nested(skill, 'skills'), name: nullableText(skill.name) }); output.skills.push(text(skill.name, { required: true })) }
    profiles.push(output); profileManifest.push(mapping)
  }
  const connectionManifest = [], connections = [], endpointPairs = new Set()
  for (const value of array(plan.connections, maxConnections)) {
    const mapping = sourceRow(value, 'connections'), fromId = id(value.fromLegacyProfileId), toId = id(value.toLegacyProfileId)
    if (!identities.profiles.has(fromId) || !identities.profiles.has(toId)) fail('dangling_profile')
    const pair = JSON.stringify([fromId, toId])
    if (endpointPairs.has(pair)) fail('duplicate_directed_edge')
    endpointPairs.add(pair)
    connections.push({ fromId, toId })
    connectionManifest.push({ ...mapping, fromLegacyProfileId: fromId, toLegacyProfileId: toId, createdAt: nullableText(value.createdAt) })
  }
  const uploads = sort(array(plan.uploads, 1000000).map(value => {
    const mapping = sourceRow(value, 'uploads'), legacyProfileId = id(value.legacyProfileId)
    if (!identities.profiles.has(legacyProfileId)) fail('dangling_profile')
    return { ...mapping, legacyProfileId, createdAt: nullableText(value.createdAt) }
  }))
  for (const table of TABLES) if (rows[table].size !== counts[table]) fail('plan_incomplete')
  const revision = `${LEGACY_PUBLIC_TRANSFORM_VERSION}:${sourceSha256}`
  return freeze({ snapshot: { state: 'published', complete: true, revision, profiles, connections }, manifest: { sourceSha256, sourceContainerSha256, transformVersion: LEGACY_PUBLIC_TRANSFORM_VERSION, revision, counts: Object.fromEntries(TABLES.map(table => [table, counts[table]])), profiles: profileManifest, connections: connectionManifest, companies, institutions, uploads } })
}
