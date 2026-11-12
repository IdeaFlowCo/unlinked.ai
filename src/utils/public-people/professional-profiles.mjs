import { createHash } from 'node:crypto'
import { parseLinkedinProfileUrl } from '../linkedin-profile-url.mjs'
import { publicWebsite } from './profile-links.mjs'
export const PROFESSIONAL_PEOPLE_DATASET = 'curated-professional-people-v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 20000
const object = value => value && Object.getPrototypeOf(value) === Object.prototype
const fields = (row, allowed, required) => object(row) && Object.keys(row).every(key => allowed.includes(key)) && required.every(key => text(row[key])) && Object.values(row).every(text)
export function professionalProfileId(url) {
  const parsed = parseLinkedinProfileUrl(url)
  if (!parsed) throw Error('professional_profile_address_required')
  return 'professional-' + hash(parsed.slug)
}
// Professional DTOs only. Original files, affiliations, private record identifiers
// and contact information have no field in this publication format.
export function prepareProfessionalSnapshot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw Error('professional_source_limit')
  const rows = JSON.parse(bytes.toString('utf8')), ids = new Set()
  if (!Array.isArray(rows) || rows.length > 5000) throw Error('professional_rows_invalid')
  for (const row of rows) {
    if (!object(row) || Object.keys(row).some(key => !['id','name','linkedinUrl','headline','company','location','about','website','positions','education','skills'].includes(key))) throw Error('professional_rows_invalid')
    const { positions, education, skills, ...scalars } = row
    if (!fields(scalars, ['id','name','linkedinUrl','headline','company','location','about','website'], ['id','name','linkedinUrl']) || row.id !== professionalProfileId(row.linkedinUrl) || parseLinkedinProfileUrl(row.linkedinUrl).url !== row.linkedinUrl || ids.has(row.id)) throw Error('professional_rows_invalid')
    if ('website' in row && publicWebsite(row.website) !== row.website) throw Error('professional_rows_invalid')
    if (!Array.isArray(positions) || positions.length > 100 || !positions.every(row => fields(row,['title','company','startDate','endDate','description'],['title','company']))) throw Error('professional_rows_invalid')
    if (!Array.isArray(education) || education.length > 100 || !education.every(row => fields(row,['institution','degree','startDate','endDate'],['institution']))) throw Error('professional_rows_invalid')
    if (!Array.isArray(skills) || skills.length > 500 || !skills.every(text)) throw Error('professional_rows_invalid')
    ids.add(row.id)
  }
  const profiles = JSON.parse(JSON.stringify(rows))
  return { state:'published', complete:true, revision:PROFESSIONAL_PEOPLE_DATASET + ':' + hash(JSON.stringify(profiles)), profiles, connections:[] }
}
export function validateProfessionalSnapshot(snapshot) {
  if (!object(snapshot) || Object.keys(snapshot).some(key => !['state','complete','revision','profiles','connections'].includes(key)) || snapshot.state !== 'published' || snapshot.complete !== true || !Array.isArray(snapshot.connections) || snapshot.connections.length) throw Error('professional_snapshot_invalid')
  const prepared = prepareProfessionalSnapshot(Buffer.from(JSON.stringify(snapshot.profiles)))
  if (snapshot.revision !== prepared.revision) throw Error('professional_snapshot_invalid')
  return prepared
}
