// Word-level matching shared by the public People list, a member's own
// contacts and the AI search shortlist. Pure text functions: no data access.
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'who', 'what', 'where', 'does', 'do', 'can', 'find', 'me', 'people', 'someone', 'with', 'on', 'at', 'for', 'of', 'in', 'and', 'or', 'to'])
export const SEARCH_MODES = Object.freeze(['best', 'exact'])

export const words = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean) : []

// A small set of word forms, so “investors” finds “investor” and “investing”,
// and “games” finds “game” and “gaming”. Deliberately not a full stemmer.
export function wordForms(term) {
  const forms = new Set([term])
  let base = term
  if (base.length > 4 && base.endsWith('ies')) base = `${base.slice(0, -3)}y`
  else if (base.length > 4 && /(?:ses|xes|zes|ches|shes)$/.test(base)) base = base.slice(0, -2)
  else if (base.length > 3 && base.endsWith('s') && !base.endsWith('ss')) base = base.slice(0, -1)
  forms.add(base)
  for (const suffix of ['ments', 'ment', 'ing', 'ors', 'or', 'ers', 'er']) if (base.endsWith(suffix) && base.length - suffix.length >= 4) forms.add(base.slice(0, -suffix.length))
  if (base.length >= 4 && base.endsWith('e')) forms.add(`${base.slice(0, -1)}ing`)
  if (base.length >= 6 && base.endsWith('ing')) forms.add(`${base.slice(0, -3)}e`)
  return [...forms]
}

const hit = (forms, list, prefixFromLength) => list.some(word => forms.some(form => word === form || (form.length >= prefixFromLength && word.startsWith(form))))

// `best`: every meaningful word, in any form and any order; when nobody has
// them all, callers fall back to people who have some. `exact`: the typed
// phrase as written. Returns null for a query with no searchable words.
export function createQueryMatcher(query, mode = 'best') {
  if (!SEARCH_MODES.includes(mode)) throw new TypeError('search_mode_invalid')
  const typed = words(query)
  if (!typed.length) return null
  if (mode === 'exact') {
    const phrase = ` ${typed.join(' ')} `
    return { mode, terms: [typed.join(' ')], test: ({ text = [], name = [] }) => { const all = ` ${text.join(' ')} `.includes(phrase); return { matched: all ? 1 : 0, all, inName: all && ` ${name.join(' ')} `.includes(phrase) ? 1 : 0, hits: [all] } } }
  }
  const meaningful = typed.filter(word => !STOP.has(word))
  const terms = [...new Set(meaningful.length ? meaningful : typed)].slice(0, 32)
  const forms = terms.map(wordForms)
  return { mode, terms, test: ({ text = [], name = [] }) => {
    let matched = 0, inName = 0
    const hits = forms.map(candidates => {
      // A name can be typed part-way (“zalad”); other text needs a whole short word (“vc”, “ai”).
      const named = hit(candidates, name, 2), found = named || hit(candidates, text, 4)
      if (found) matched++
      if (named) inName++
      return found
    })
    return { matched, all: matched === terms.length, inName, hits }
  } }
}

// Rank rows for a matcher. When any row has every word, only those are kept,
// unless `keepPartial` asks for the rest after them. Among partial matches a
// rarer word counts for more, so “game” outranks “partner” when few people have it.
export function rankMatches(rows, matcher, tokens, { tie = () => 0, keepPartial = false } = {}) {
  const scored = [], frequency = matcher.terms.map(() => 0)
  for (const row of rows) {
    const result = matcher.test(tokens(row))
    if (!result.matched) continue
    result.hits.forEach((found, index) => { if (found) frequency[index]++ })
    scored.push({ row, ...result })
  }
  const weight = frequency.map(count => count ? Math.log(1 + scored.length / count) : 0)
  for (const value of scored) value.score = value.hits.reduce((sum, found, index) => sum + (found ? weight[index] : 0), 0)
  const order = (a, b) => Number(b.all) - Number(a.all) || b.score - a.score || b.inName - a.inName || tie(a.row, b.row)
  const complete = scored.filter(value => value.all)
  const kept = complete.length && !keepPartial ? complete : scored
  kept.sort(order)
  return { rows: kept.map(value => value.row), match: !scored.length ? 'none' : complete.length ? 'all' : 'some', matched: scored.length, complete: complete.length }
}
