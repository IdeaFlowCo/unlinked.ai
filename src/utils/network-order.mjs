// Browser listing order. Dates are private relationship metadata, never public profile dates.
export const PUBLIC_NETWORK_SORTS = Object.freeze(['best', 'name', 'name-desc'])
export const NETWORK_SORTS = Object.freeze([...PUBLIC_NETWORK_SORTS, 'connected', 'imported'])
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true, ignorePunctuation: true })
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
export function orderNetwork(rows, sort = 'best', name = row => row.name ?? '') {
  if (sort === 'best') return rows
  return [...rows].sort((a, b) => {
    if (sort === 'connected' || sort === 'imported') {
      const key = sort === 'connected' ? 'connectedAt' : 'importedAt'
      const date = (validTimestamp(b[key]) ?? 0) - (validTimestamp(a[key]) ?? 0)
      if (date) return date
    }
    const names = collator.compare(name(a), name(b))
    return (sort === 'name-desc' ? -names : names) || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
}
