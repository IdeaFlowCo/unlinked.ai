import { parseLegacyCopy } from './postgres-copy.mjs'

const fail = code => { throw new Error(code) }
const requiredId = value => { if (typeof value !== 'string' || !value.trim()) fail('legacy_plan_id_invalid'); return value }
const nullableId = value => value === null ? null : requiredId(value)
const provenance = row => ({ ...row.provenance })
export function createLegacyPlan(source, { sourceContainerSha256 = null, ...limits } = {}) {
  if (sourceContainerSha256 !== null && (typeof sourceContainerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceContainerSha256))) fail('legacy_plan_container_hash_invalid')
  const { sourceSha256, tables } = parseLegacyCopy(source, limits)
  const indexes = Object.fromEntries(Object.entries(tables).map(([table, rows]) => {
    const ids = new Map()
    for (const row of rows) {
      const id = requiredId(row.id)
      if (ids.has(id)) fail(`legacy_plan_duplicate_${table}`)
      ids.set(id, row)
    }
    return [table, ids]
  }))
  const lookup = (table, id) => {
    requiredId(id)
    if (!indexes[table].has(id)) fail(`legacy_plan_dangling_${table}`)
    return indexes[table].get(id)
  }
  const nullableLookup = (table, id) => id === null ? null : lookup(table, id)
  const profiles = tables.profiles.map(row => ({
    legacyId: row.id, legacyUserId: nullableId(row.user_id), name: row.full_name,
    headline: row.headline, linkedinSlug: row.linkedin_slug, about: row.summary, industry: row.industry,
    createdAt: row.created_at, updatedAt: row.updated_at,
    positions: [], education: [], skills: [], provenance: provenance(row),
  }))
  const profileById = new Map(profiles.map(profile => [profile.legacyId, profile]))
  const profile = id => { lookup('profiles', id); return profileById.get(id) }
  for (const row of tables.positions) {
    const company = nullableLookup('companies', row.company_id)
    profile(row.profile_id).positions.push({ legacyId: row.id, legacyProfileId: row.profile_id, legacyCompanyId: company?.id ?? null, company: company?.name ?? null, companyProvenance: company === null ? null : provenance(company), title: row.title, description: row.description, startedOn: row.started_on, finishedOn: row.finished_on, createdAt: row.created_at, provenance: provenance(row) })
  }
  for (const row of tables.education) {
    const institution = nullableLookup('institutions', row.institution_id)
    profile(row.profile_id).education.push({ legacyId: row.id, legacyProfileId: row.profile_id, legacyInstitutionId: institution?.id ?? null, institution: institution?.name ?? null, institutionProvenance: institution === null ? null : provenance(institution), degree: row.degree_name, startedOn: row.started_on, finishedOn: row.finished_on, createdAt: row.created_at, provenance: provenance(row) })
  }
  for (const row of tables.skills) profile(row.profile_id).skills.push({ legacyId: row.id, legacyProfileId: row.profile_id, name: row.name, createdAt: row.created_at, provenance: provenance(row) })
  const directedEdges = new Set()
  const connections = tables.connections.map(row => {
    lookup('profiles', row.profile_id_a); lookup('profiles', row.profile_id_b)
    const endpoints = JSON.stringify([row.profile_id_a, row.profile_id_b])
    if (directedEdges.has(endpoints)) fail('legacy_plan_duplicate_directed_edge')
    directedEdges.add(endpoints)
    return { legacyId: row.id, fromLegacyProfileId: row.profile_id_a, toLegacyProfileId: row.profile_id_b, createdAt: row.created_at, provenance: provenance(row) }
  })
  const uploads = tables.uploads.map(row => {
    lookup('profiles', row.profile_id)
    return { legacyId: row.id, legacyProfileId: row.profile_id, filePath: row.file_path, filename: row.file_name, createdAt: row.created_at, provenance: provenance(row) }
  })
  const organizations = table => tables[table].map(row => ({ legacyId: row.id, name: row.name, createdAt: row.created_at, provenance: provenance(row) }))
  return { sourceSha256, sourceContainerSha256, counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])), profiles, connections, uploads, companies: organizations('companies'), institutions: organizations('institutions'), issues: [] }
}
