// Deterministic owner-network text match: every query word must start a word
// in the connection's name, company or position. Instant, complete and
// model-free, so a plain company/name/title query never waits on AI ranking.
export const TEXT_MATCH_LIMIT = 500
const FIELDS = [['name', row => [row.fields?.['first name'], row.fields?.['last name']]], ['company', row => [row.fields?.company]], ['position', row => [row.fields?.position]]]

const normalize = value => String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const words = value => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export function textQueryTerms(query) {
  const terms = words(query)
  return terms.length && terms.length <= 8 ? terms : null
}

export function matchNetworkText(assertions, query, limit = TEXT_MATCH_LIMIT) {
  const terms = textQueryTerms(query)
  if (!terms) return null
  const matches = []
  for (const row of assertions) {
    if (row.category !== 'connections') continue
    const fieldWords = FIELDS.map(([label, read]) => [label, read(row).filter(value => typeof value === 'string').flatMap(words)])
    const hit = term => fieldWords.find(([, list]) => list.some(word => word.startsWith(term)))?.[0]
    const labels = terms.map(hit)
    if (labels.some(label => !label)) continue
    matches.push({ row, matchedIn: [...new Set(labels)] })
  }
  const name = ({ row }) => [row.fields?.['first name'], row.fields?.['last name']].filter(Boolean).join(' ')
  matches.sort((a, b) => name(a).localeCompare(name(b)) || String(a.row.id).localeCompare(String(b.row.id)))
  return { total: matches.length, truncated: matches.length > limit, matches: matches.slice(0, limit) }
}
