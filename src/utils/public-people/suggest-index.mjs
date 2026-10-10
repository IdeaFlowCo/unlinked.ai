// Header autocomplete over the published People index (docs/omni-search.md).
// A sorted-vocabulary prefix index is built once per compiled snapshot, so a
// keystroke visits only the postings of the words it can complete instead of
// scanning every profile. Pure data structure: no reads, no private data.
import { words, wordForms } from './text-match.mjs'
import { linkedinSlug } from './url-identity.mjs'

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'who', 'what', 'where', 'does', 'do', 'can', 'find', 'me', 'people', 'someone', 'with', 'on', 'at', 'for', 'of', 'in', 'and', 'or', 'to'])
const MAX_TERMS = 8
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// token -> ascending document ordinals, with the vocabulary in code-unit order
// so every word with a given prefix sits in one contiguous range.
function prefixIndex(documents) {
  const postings = new Map()
  documents.forEach((tokens, ordinal) => {
    for (const token of new Set(tokens)) { let list = postings.get(token); if (!list) postings.set(token, list = []); list.push(ordinal) }
  })
  const vocabulary = [...postings.keys()].sort(compare)
  return { vocabulary, postings: vocabulary.map(token => Int32Array.from(postings.get(token))) }
}
function lowerBound(vocabulary, key) {
  let low = 0, high = vocabulary.length
  while (low < high) { const middle = (low + high) >> 1; if (vocabulary[middle] < key) low = middle + 1; else high = middle }
  return low
}
// Calls visit(ordinal) for every document with a word equal to `form`, or
// starting with it when `prefix`. A document may be visited more than once.
function each(index, form, prefix, visit) {
  const { vocabulary, postings } = index
  let position = lowerBound(vocabulary, form)
  if (!prefix) { if (vocabulary[position] === form) for (const ordinal of postings[position]) visit(ordinal); return }
  for (; position < vocabulary.length && vocabulary[position].startsWith(form); position++) for (const ordinal of postings[position]) visit(ordinal)
}

// What a keystroke can complete, in the same words the directory uses:
// names, headlines, companies, position titles and companies, schools and
// skills. Longer free text (about, position descriptions) is left to the
// full search page.
export function buildSuggestIndex(data) {
  const people = data.ordered
  const names = people.map(person => words(person.name))
  const professional = people.map((person, ordinal) => {
    const detail = data.details.get(person.id) ?? {}
    return [...names[ordinal], ...words([person.headline, detail.company, ...(detail.positions ?? []).flatMap(position => [position.title, position.company]), ...(detail.education ?? []).map(school => school.institution), ...(detail.skills ?? [])].filter(Boolean).join(' '))]
  })
  const companies = data.companyList ?? []
  return {
    size: people.length,
    names: prefixIndex(names), professional: prefixIndex(professional),
    companies: prefixIndex(companies.map(company => company.tokens)),
    normalizedNames: people.map(person => normalized(person.name)),
    slugs: people.map(person => linkedinSlug(data.details.get(person.id)?.linkedinUrl ?? '') ?? null),
  }
}

// Terms of a typed query: meaningful words, and always the last word, which
// is usually still being typed ("jacob an" completes "Andrew").
export function suggestTerms(search) {
  const typed = words(search)
  if (!typed.length) return []
  const terms = [...typed.slice(0, -1).filter(word => !STOP.has(word)), typed.at(-1)]
  return [...new Set(terms)].slice(-MAX_TERMS)
}

// Ordinals of documents that have every term. A name word may be typed
// part-way from two letters, the last term from one; other text needs four
// letters before it completes ("vc" and "ai" must be whole words), except the
// last term, which completes from two. Word forms
// follow the directory ("investors" finds "investor").
function matchAll(terms, { name, other, size }) {
  const count = new Uint8Array(size), inName = new Uint8Array(size), seen = new Int16Array(size).fill(-1)
  let survivors = null
  terms.forEach((term, index) => {
    const last = index === terms.length - 1, forms = wordForms(term), next = []
    const mark = named => ordinal => {
      if (count[ordinal] !== index || seen[ordinal] === index) return
      seen[ordinal] = index; count[ordinal]++; if (named) inName[ordinal]++; next.push(ordinal)
    }
    const markName = mark(true), markOther = mark(false)
    for (const form of forms) each(name, form, form.length >= 2, markName)
    if (last && term.length < 2) each(name, term, true, markName)
    if (other) for (const form of forms) each(other, form, form.length >= 4, markOther)
    // The word being typed completes in other text from two letters ("northwind cap").
    if (other && last && term.length >= 2 && term.length < 4) each(other, term, true, markOther)
    survivors = next
  })
  return { ordinals: survivors ?? [], inName }
}

// At most `limit` people with every term, one per person: names that have
// every word first, then an exact or leading name match, then people the
// signed-in member already knows, members before imported profiles, more
// connected people, then name order. Two published profiles with the same
// LinkedIn address are one person; the earlier one stays.
export function suggestPeople(index, data, search, { limit = 5, known = null } = {}) {
  const terms = suggestTerms(search)
  if (!terms.length) return []
  const { ordinals, inName } = matchAll(terms, { name: index.names, other: index.professional, size: index.size })
  const query = normalized(search)
  const priority = ordinal => index.normalizedNames[ordinal] === query ? 2 : index.normalizedNames[ordinal].startsWith(query) ? 1 : 0
  const scored = ordinals.map(ordinal => {
    const person = data.ordered[ordinal]
    return { ordinal, person, allNamed: inName[ordinal] === terms.length ? 1 : 0, priority: priority(ordinal), known: known?.has(person.id) ? 1 : 0, member: person.presence === 'member' ? 1 : 0, reach: Number.isSafeInteger(person.connectionCount) ? person.connectionCount : 0 }
  })
  scored.sort((a, b) => b.allNamed - a.allNamed || b.priority - a.priority || b.known - a.known || b.member - a.member || b.reach - a.reach || a.ordinal - b.ordinal)
  const result = [], slugs = new Set()
  for (const value of scored) {
    const slug = index.slugs[value.ordinal]
    if (slug && slugs.has(slug)) continue
    if (slug) slugs.add(slug)
    result.push(value.known ? { ...value.person, known: true } : value.person)
    if (result.length >= limit) break
  }
  return result
}

// At most `limit` distinct company names from visible positions with every term.
export function suggestCompanies(index, data, search, { limit = 3 } = {}) {
  const terms = suggestTerms(search)
  const companies = data.companyList ?? []
  if (!terms.length || !companies.length) return []
  const { ordinals } = matchAll(terms, { name: index.companies, other: null, size: companies.length })
  const query = normalized(search)
  const priority = name => { const value = normalized(name); return value === query ? 2 : value.startsWith(query) ? 1 : 0 }
  return ordinals.map(ordinal => companies[ordinal]).sort((a, b) => priority(b.name) - priority(a.name) || compare(normalized(a.name), normalized(b.name))).slice(0, limit).map(({ name }) => ({ name }))
}
