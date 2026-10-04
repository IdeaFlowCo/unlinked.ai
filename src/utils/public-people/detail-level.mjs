// Depth describes visible content, independently of membership or graph reach.
const text = value => typeof value === 'string' && Boolean(value.trim())
const rows = value => Array.isArray(value) ? value : []
export function profileDetailLevel(profile = {}) {
  const positions = rows(profile.positions).filter(value => text(value.title) || text(value.company) || text(value.description))
  return text(profile.about) || rows(profile.skills).some(text) || rows(profile.education).some(value => text(value.institution) || text(value.degree)) || positions.length > 1 || positions.some(value => text(value.description) || text(value.startDate) || text(value.endDate)) ? 'detailed' : 'basic'
}
export function companyDetailLevel(facts) {
  return facts && (['description', 'tagline', 'industry', 'headquarters', 'founded', 'website'].some(key => text(facts[key])) || Number.isSafeInteger(facts.employeeCount) && facts.employeeCount > 0) ? 'detailed' : 'basic'
}
