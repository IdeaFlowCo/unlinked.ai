// Conservative title evidence for common explicit role requests. The model still
// handles semantic relevance and roles outside this vocabulary. Company names
// alone never make somebody an investor, engineer, recruiter, etc.
const investmentCompany = /\b(?:ventures?|venture capital|capital|investments?|investment management|vc|fund)\b/i
const investmentTitle = /\b(?:investors?(?!\s+relations)|investing|venture capitalists?|general partner|fund manager|investment (?:partner|manager|director|analyst))\b/i
const investmentFirmTitle = /^(?:(?:managing|investment|venture|senior|junior|founding)\s+)*(?:partner|principal|associate|managing director)(?:\s*(?:[,|&/–-]|$)|\s+(?:at|of)\b)/i
const roles = [
  { name: 'investor', query: /\b(?:investors?|venture capitalists?|angel investors?|invest(?:s|ing)? in)\b/i,
    supports: fields => investmentTitle.test(fields.position ?? '') || investmentCompany.test(fields.company ?? '') && investmentFirmTitle.test(fields.position ?? '') },
  { name: 'engineer', query: /\b(?:engineers?|developers?|programmers?)\b/i, title: /\b(?:engineers?|developers?|programmers?|cto|chief technology officer|engineering (?:manager|director|lead|leader)|(?:head|director|vp|vice president) (?:of )?(?:software )?engineering)\b/i },
  { name: 'recruiter', query: /\b(?:recruiters?|talent acquisition)\b/i, title: /\b(?:recruiters?|recruiting|recruitment|talent acquisition)\b/i },
  { name: 'designer', query: /\bdesigners?\b/i, title: /\bdesigners?\b/i },
  { name: 'founder', query: /\bfounders?\b/i, title: /\bfounders?\b/i },
  { name: 'CEO', query: /\b(?:ceos?|chief executive officers?)\b/i, title: /\b(?:ceo|chief executive officer)\b/i },
]
const sectors = [
  { name: 'Gaming', terms: /\b(?:gaming|games?|esports?)\b/i },
  { name: 'Climate', terms: /\b(?:climate|cleantech|clean tech|decarboni[sz]ation|renewable energy)\b/i },
]

function quote(value) {
  let text = value
  while (JSON.stringify(text).length > 180) text = text.slice(0, -1)
  return JSON.stringify(text + (text.length < value.length ? '…' : ''))
}

export function searchEvidence(query) {
  // Compound, exclusion and relationship requests belong to the semantic
  // ranker, rather than interpreting every role mentioned as a required role.
  if (/\b(?:not|no|never|neither|nor|but|except|excluding|or|without|hiring|hires?|recruiting|recruits?|knows?|introductions?|introduce)\b/i.test(query) || /\bnon[-\s]|\bother\s+than\b/i.test(query)) return null
  if (roles.filter(role => role.query.test(query)).length > 1) return null
  const target = query.replace(/^who\s+(?:is|are)\s+/i, '').split(/\b(?:who|that|which|at|from|for|with|in|on)\b/i)[0].replace(/[\s?!.,:;]+$/g, '')
  const requested = roles.filter(role => role.query.test(target))
  const investingRequest = !requested.length && /\b(?:who|that)\s+invests?\s+in\b/i.test(query)
  if (investingRequest) requested.push(roles[0])
  if (requested.length !== 1) return null
  // A role must end the target phrase, before a sector/company clause. This
  // avoids treating company names or e.g. investor-relations managers as a
  // request for founders/investors; uncertain grammar stays with the model.
  if (!investingRequest && !new RegExp(`${requested[0].query.source}$`, 'i').test(target)) return null
  const role = requested[0]
  const sector = sectors.find(value => value.terms.test(query))
  return { role: role.name, sector: sector?.name,
    supports: fields => role.supports ? role.supports(fields) : role.title.test(fields.position ?? ''),
    sectorSupport: fields => sector ? sector.terms.test(fields.position ?? '') || sector.terms.test(fields.company ?? '') : false,
    reason: fields => {
      // Quote bounded supplied fields; never reuse model speculation as facts.
      // Total stays under the existing 512-character reason contract.
      const facts = [`Title: ${quote(fields.position ?? '')}.`, ...(fields.company ? [`Company: ${quote(fields.company)}.`] : [])]
      if (sector) facts.push(sector.terms.test(fields.position ?? '') || sector.terms.test(fields.company ?? '')
        ? `${sector.name} is mentioned in these fields; sector focus is not independently verified.`
        : `${sector.name} sector focus is not evidenced in the supplied fields.`)
      if (!sector && role.name === 'investor') facts.push('Investment sector focus is not established by this role evidence.')
      return facts.join(' ')
    },
  }
}
