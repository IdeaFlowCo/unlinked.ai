// Reviewed company facts. The static list below was fetched once from LinkedIn
// company profiles via the operator's Unipile workspace on 2026-10-02 and is
// the floor: the operator-published graph dataset `curated-companies-v1`
// (docs/company-facts.md, mcp-server/publish-company-facts.mjs) is merged over
// it at runtime. The runtime never calls an external API for these; absent
// companies simply show the people list alone.
const COMPANIES = [
  {"name": "Alignment Growth", "tagline": "Growth Equity Investor in Media, Entertainment & Gaming", "description": "Alignment Growth is an investment manager focused on growth-stage, privately held companies across media, entertainment, and gaming.\n\nLeveraging its leadership team’s multi-decade track record of operating, strategy, and dealmaking experience as senior executives of global Fortune 500 companies, Alignment Growth provides value-added capital solutions to entrepreneurs seeking to build world-class businesses and…", "industry": "Investment Management", "employeeCount": 16, "headquarters": "New York, US", "founded": "2021", "linkedinUrl": "https://www.linkedin.com/company/alignment-growth/"},
  {"name": "CASSIUS", "tagline": "We are early-stage technology investors across North America and Europe.", "description": "We are early-stage technology investors across North America and Europe.", "industry": "Venture Capital and Private Equity Principals", "employeeCount": 21, "founded": "2017", "linkedinUrl": "https://www.linkedin.com/company/cassius-family/", "aliases": ["Cassius Family", "Cassius"]},
  {"name": "Corner3 Ventures", "tagline": "Seed and venture investment company backing the most ambitious founders at the earliest stages of their journey.", "description": "We believe that founders will change the world.  But change is not a destination, it’s a journey.\n\nAt Corner3, we seek to partner with the most ambitious founders at the earliest stages of their journey. We invest in both B2B and B2C companies ranging from the first check through the first round of institutional financing. With our diverse backgrounds across operations, finance and media we are ready to support…", "industry": "Venture Capital and Private Equity Principals", "employeeCount": 3, "headquarters": "New York City, US", "linkedinUrl": "https://www.linkedin.com/company/corner3-ventures/"},
  {"name": "Datavore (Acquired by Above Data)", "tagline": "The Code-Free Tool for Advance Time Series Analysis", "description": "Our Product:\nDatavore is an adaptive data analytics platform that allows you to quickly explore your datasets and ask meaningful questions. Our intuitive interface enables you to easily create repeatable workflows for data aggregation, normalization, analysis, and visualization.\n\nOur Team:\nThe Datavore team has deep domain expertise in databases, time series, and analytics with a successful track record of…", "industry": "Software Development", "headquarters": "New York, US", "founded": "2014", "linkedinUrl": "https://www.linkedin.com/company/datavorelabs/", "aliases": ["Datavore"]},
  {"name": "Goldman Sachs", "description": "We aspire to be the world’s most exceptional financial institution, united by our shared values of partnership, client service, integrity, and excellence. \n\nOperating at the center of capital markets, we act as one firm, mobilizing our people, capital, and ideas to deliver superior results across our clients’ most complex challenges.\n\nFor 157 years, Goldman Sachs has delivered world-class execution on a global…", "industry": "Financial Services", "employeeCount": 67001, "headquarters": "New York, US", "linkedinUrl": "https://www.linkedin.com/company/goldman-sachs/"},
  {"name": "Kanga (Acquired by Riot Games)", "tagline": "Building unique products for gamers and creators since 2018.  Joined Riot Games 2021", "description": "Building unique products for gamers and creators since 2018.  Joined RiotGames 2021.", "industry": "Software Development", "employeeCount": 4, "headquarters": "New York, NY, US", "founded": "2018", "linkedinUrl": "https://www.linkedin.com/company/kanga-gg/", "aliases": ["Kanga"]},
  {"name": "Mana Verse PBC", "tagline": "Helping people build stronger, more secure relationships.", "industry": "Mental Health Care", "employeeCount": 2, "linkedinUrl": "https://www.linkedin.com/company/mana-verse-pbc/", "aliases": ["Mana Verse"]},
  {"name": "Raptor Group", "description": "At The Raptor Group, we source and invest in companies across various stages and asset classes, ranging from early stage to both private and public equity to funds.\n\nBacked by the Family Office of Jim Pallotta, The Raptor Group focuses on various industries including, but not limited to, technology, fintech, sports, consumer, media, entertainment, and healthcare.\n\nWe look for investment opportunities where we can…", "industry": "Investment Management", "employeeCount": 31, "headquarters": "Boston, Massachusetts, US", "linkedinUrl": "https://www.linkedin.com/company/raptorgroup/"},
  {"name": "Riot Games", "tagline": "Rioters wanted: we’re looking for humble, but ambitious, razor-sharp pros who take play seriously.", "description": "Since 2006, Riot Games has stayed committed to changing the way video games are developed, published, and supported for players. From our first title, League of Legends, to 2020’s VALORANT; we have strived to evolve the community with growth in Esports, and expansion from games into entertainment. Players are the foundation of Riot's community and because of them, we’re able to reach new heights.\n\nFounded by…", "industry": "Computer Games", "employeeCount": 8343, "headquarters": "Los Angeles, CA, US", "founded": "2006", "linkedinUrl": "https://www.linkedin.com/company/riot-games/"},
  {"name": "Savor", "tagline": "Feel good fats made from scratch.", "description": "Savor believes in a future where we can enjoy the products we love without consuming our planet. Founded in 2022 and backed by leading investors like Breakthrough Energy Ventures and Synthesis Capital, the company's proprietary platform follows nature's own blueprints to create pure, versatile and sustainable fats and oils directly from carbon without the need for conventional plant and animal agriculture.…", "industry": "Manufacturing", "employeeCount": 122, "headquarters": "San Jose, California, US", "founded": "2022", "linkedinUrl": "https://www.linkedin.com/company/savor-it/"},
  {"name": "Smartcar", "tagline": "Build and scale your mobility business 🚀", "description": "At Smartcar, we empower developers to build the future of mobility. Our API allows web and mobile apps to verify mileage, manage EV charging, issue digital car keys, track fleets, and much more.\n\nThe Smartcar platform is compatible with 40 car brands across the US and beyond and works without aftermarket hardware like OBD dongles.\n\nSmartcar powers leading apps for repair and maintenance, DERMS/VPPs, car…", "industry": "Software Development", "employeeCount": 124, "headquarters": "Mountain View, California, US", "founded": "2015", "linkedinUrl": "https://www.linkedin.com/company/smartcar/", "aliases": ["Smartcar, Inc."]},
  {"name": "Speechify", "tagline": "Your Voice AI Assistant", "description": "Speechify is the Voice AI Assistant you’ve always wanted. \n\nSpeechify reads, types, talks, and answers for you. Trusted by 50+ million users.\n\nWant to read faster? Speechify reads any Google Doc, PDF, webpage, or book aloud in 1000+ lifelike voices across 60+ languages, at up to 4.5x speed.\n\nHave a question? Just ask – Speechify already has context from the articles, books, and documents on your screen. It’s like…", "industry": "Software Development", "employeeCount": 203, "headquarters": "Remote, US", "founded": "2017", "linkedinUrl": "https://www.linkedin.com/company/speechifyinc/", "aliases": ["Speechify AI"]},
  {"name": "Techstars", "tagline": "Techstars helps founders scale their startups into world-changing businesses.", "description": "Techstars helps founders scale their startups into world-changing businesses.\n\nFounded in 2006, Techstars is on a mission to invest in startups to enable more capital to flow to more entrepreneurs around the world in order to deliver exceptional  returns to our investors. We do this by operating accelerator programs and venture capital funds, as well as by connecting startups, investors, corporations, and cities…", "industry": "Venture Capital and Private Equity Principals", "employeeCount": 2542, "headquarters": "New York City, New York, US", "founded": "2006", "linkedinUrl": "https://www.linkedin.com/company/techstars/"},
  {"name": "Templum", "tagline": "The new frontier for private markets.", "description": "Templum is the operating infrastructure for the future of private markets.\n\nWe built it because nothing adequate existed.\n\nAs demand for private and alternative investments accelerated, firms were forced to rely on fragmented systems, manual workflows, and expensive legacy technology that struggled to scale.\n\nTemplum was built to solve that.\n\nOur platform unifies the full investment lifecycle across primary…", "industry": "Financial Services", "employeeCount": 33, "headquarters": "Miami, Florida, US", "founded": "2018", "linkedinUrl": "https://www.linkedin.com/company/templuminc/", "aliases": ["Templum, Inc."]}
]

export const COMPANY_DATASET = 'curated-companies-v1'
export const COMPANY_FIELDS = ['name', 'tagline', 'description', 'industry', 'employeeCount', 'headquarters', 'founded', 'website', 'linkedinUrl', 'aliases']

export const companyKey = value => (typeof value === 'string' ? value : '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean).join(' ')
const keysOf = company => [company.name, ...(company.aliases ?? [])].map(companyKey)

const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
const short = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const long = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000
const https = value => { if (!long(value)) return false; try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') } catch { return false } }
const LINKEDIN_COMPANY = /^https:\/\/www\.linkedin\.com\/company\/[A-Za-z0-9%._~-]+\/?$/
const CHECKS = {
  name: short, tagline: long, description: long, industry: short, headquarters: short, founded: short,
  employeeCount: value => Number.isSafeInteger(value) && value >= 0,
  website: https,
  linkedinUrl: value => typeof value === 'string' && value.length <= 300 && LINKEDIN_COMPANY.test(value),
  aliases: value => Array.isArray(value) && value.length <= 50 && value.every(short),
}

// The one whitelist for company rows: the offline publisher, the graph store
// and the runtime reader all apply it, so a bad row can never reach a page.
// Every name and alias must normalize to a non-empty key no other row claims.
export function validateCompanyRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) throw new Error('company_rows_invalid')
  const claimed = new Set()
  return rows.map((row, index) => {
    if (!plain(row) || !short(row.name)) throw new Error(`company_row_invalid:${index}`)
    for (const [field, value] of Object.entries(row)) if (!COMPANY_FIELDS.includes(field) || !CHECKS[field](value)) throw new Error(`company_row_invalid:${index}:${field}`)
    for (const key of new Set(keysOf(row))) {
      if (!key || claimed.has(key)) throw new Error(`company_row_duplicate:${index}`)
      claimed.add(key)
    }
    return Object.fromEntries(COMPANY_FIELDS.filter(field => row[field] !== undefined).map(field => [field, field === 'aliases' ? [...row[field]] : row[field]]))
  })
}

// Graph rows win: a static company that shares any normalized name or alias
// with a graph row is superseded whole. Its other static aliases keep
// resolving, but to the graph row, so a stale static fact is never served and
// positions written as e.g. "Smartcar, Inc." still find the published company.
export function buildCompanyIndex(graphRows = []) {
  const index = new Map(), graph = new Map(graphRows.flatMap(company => keysOf(company).map(key => [key, company])))
  for (const company of COMPANIES) {
    const keys = keysOf(company), winner = keys.map(key => graph.get(key)).find(Boolean) ?? company
    for (const key of keys) if (!graph.has(key)) index.set(key, winner)
  }
  for (const [key, company] of graph) index.set(key, company)
  return index
}

const copy = company => company ? { ...company, ...(company.aliases ? { aliases: [...company.aliases] } : {}) } : null
const staticIndex = buildCompanyIndex()

// Static-only lookup, kept for callers without a graph.
export const companyFacts = name => copy(staticIndex.get(companyKey(name)))

// Runtime lookup: `readDataset()` returns the published dataset ({ revision,
// companies }) or null. The merged index is cached for `ttlMs`, one read at a
// time. Any read or validation failure falls back to the static list (also
// cached for `ttlMs`, so a down graph is not retried on every page view) and
// never throws to the company page.
export function createCompanyFacts({ readDataset, ttlMs = 60000, now = Date.now, onError = () => {} } = {}) {
  if (typeof readDataset !== 'function') return async name => companyFacts(name)
  let cached = null, expires = 0, pending = null
  const refresh = async () => {
    try {
      const dataset = await readDataset()
      return buildCompanyIndex(dataset ? validateCompanyRows(dataset.companies) : [])
    } catch (error) {
      try { onError(error) } catch { /* reporting never breaks a page */ }
      return staticIndex
    }
  }
  return async name => {
    if (!cached || now() >= expires) {
      pending ??= refresh().then(index => { cached = index; expires = now() + ttlMs; return index }).finally(() => { pending = null })
      await pending
    }
    return copy(cached.get(companyKey(name)))
  }
}
