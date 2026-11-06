// Browser and reader share the same bounded, URL-serializable filter contract.
export const PEOPLE_FILTER_KEYS = Object.freeze(['degree', 'location', 'company', 'pastCompany', 'title', 'school', 'industry'])
export function peopleFilters(input = {}) {
  const result = {}
  for (const key of PEOPLE_FILTER_KEYS) {
    const values = input instanceof URLSearchParams ? input.getAll(key) : [input[key]].filter(value => value !== undefined)
    if (values.length > 1 || values.some(value => typeof value !== 'string' || value.length > 120)) throw Error('people_filter_invalid')
    const value = (values[0] ?? '').trim()
    if (key === 'degree' && value && !['1', '2', '3'].includes(value)) throw Error('people_filter_invalid')
    if (value) result[key] = value
  }
  return result
}
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
const has = (values, query) => !query || values.some(value => normalize(value).includes(normalize(query)))
export function matchesPeopleFilters(profile, filters) {
  if (!PEOPLE_FILTER_KEYS.some(key => key !== 'degree' && filters[key])) return true
  const positions = profile.positions ?? [], current = positions.filter(position => !position.endDate || /^(present|current)$/i.test(position.endDate))
  return has([profile.location], filters.location)
    && has([profile.company, ...current.map(position => position.company)], filters.company)
    && has(positions.filter(position => position.endDate && !/^(present|current)$/i.test(position.endDate)).map(position => position.company), filters.pastCompany)
    && has([profile.headline, ...current.map(position => position.title)], filters.title)
    && has((profile.education ?? []).map(school => school.institution), filters.school)
    && has([profile.industry], filters.industry)
}

// Shortest recorded path from the viewer's known first-degree people. Every
// additional hop obeys the existing connection-list audience policy. A missing
// path means unknown, never an invented third-degree relationship.
export function connectionDegrees({ seeds, self, connected, visible }) {
  const distances = new Map()
  if (self) distances.set(self, 0)
  let frontier = []
  for (const id of seeds) if (id !== self && !distances.has(id)) { distances.set(id, 1); frontier.push(id) }
  for (let degree = 2; degree <= 3; degree++) {
    const next = []
    for (const id of frontier) for (const other of connected.get(id) ?? []) {
      if (distances.has(other) || !visible(id, other)) continue
      distances.set(other, degree); next.push(other)
    }
    frontier = next
  }
  return distances
}
