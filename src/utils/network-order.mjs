// Browser listing order. Dates are private relationship metadata, never public profile dates.
export const PUBLIC_NETWORK_SORTS = Object.freeze(['best', 'name', 'name-desc'])
export const NETWORK_SORTS = Object.freeze([...PUBLIC_NETWORK_SORTS, 'connected', 'imported'])
// Agent tool orders (unlinked-tto.2). `raw` is true Unicode code-point order of
// the name exactly as written; every other name order uses nameSortKey.
export const PUBLIC_LIST_SORTS = Object.freeze([...PUBLIC_NETWORK_SORTS, 'raw'])
export const CONNECTION_SORTS = Object.freeze(['name', 'raw', 'name-desc', 'connected', 'imported', 'company'])
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true, ignorePunctuation: true })
// The part of a name that sorts: from its first letter or number, so leading
// emoji, symbols, quotes and punctuation never decide the order. Display names
// are never changed; this is only a comparison key.
export const nameSortKey = value => {
  const text = typeof value === 'string' ? value.normalize('NFKC') : ''
  const start = text.search(/[\p{L}\p{N}]/u)
  return start < 0 ? text.trim() : text.slice(start)
}
// Accent- and case-insensitive, numeric-aware comparison of name sort keys.
export const compareNames = (a, b) => collator.compare(nameSortKey(a), nameSortKey(b))
// True code-point order (JS `<` compares UTF-16 units, which misorders astral characters).
export function compareCodePoints(a, b) {
  a = String(a ?? ''); b = String(b ?? '')
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i), y = b.codePointAt(j)
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1
  }
  return Number(i < a.length) - Number(j < b.length)
}
export const validTimestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : undefined
export function connectionDate(value) {
  if (typeof value !== 'string') return undefined
  // LinkedIn Connections.csv uses e.g. "04 Oct 2026"; do not guess ambiguous numeric dates.
  if (!/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const at = validTimestamp(Date.parse(value + (/^[0-9]{4}-/.test(value) ? 'T00:00:00Z' : ' 00:00:00 GMT')))
  if (!at) return undefined
  const date = new Date(at)
  if (/^[0-9]{4}-/.test(value)) return date.toISOString().slice(0, 10) === value ? at : undefined
  const [day, month, year] = value.split(' ')
  return date.getUTCDate() === Number(day) && date.getUTCFullYear() === Number(year) && date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }).toLowerCase() === month.toLowerCase() ? at : undefined
}
const idOrder = (a, b) => compareCodePoints(String(a.id ?? ''), String(b.id ?? ''))
// Sort-key accessors are computed once per row, not once per comparison.
export function orderNetwork(rows, sort = 'best', name = row => row.name ?? '', company = row => row.company ?? '') {
  if (sort === 'best') return rows
  if (sort === 'raw') return [...rows].sort((a, b) => compareCodePoints(name(a), name(b)) || idOrder(a, b))
  const keys = new Map(rows.map(row => [row, { name: nameSortKey(name(row)), company: nameSortKey(company(row)) }]))
  return [...rows].sort((a, b) => {
    const left = keys.get(a), right = keys.get(b)
    if (sort === 'connected' || sort === 'imported') {
      const key = sort === 'connected' ? 'connectedAt' : 'importedAt'
      const date = (validTimestamp(b[key]) ?? 0) - (validTimestamp(a[key]) ?? 0)
      if (date) return date
    }
    if (sort === 'company') {
      // People without a company come last.
      const missing = Number(!left.company) - Number(!right.company)
      if (missing) return missing
      const companies = collator.compare(left.company, right.company)
      if (companies) return companies
    }
    const names = collator.compare(left.name, right.name)
    return (sort === 'name-desc' ? -names : names) || idOrder(a, b)
  })
}
