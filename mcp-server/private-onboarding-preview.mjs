import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderJoin, renderBringArchive, renderImporting, renderOwnProfile, renderPeople, renderSettings } from './private-onboarding-views.mjs'

// Fictional DTOs only. This generator never starts a server or contacts a service.
const account = { accountLabel: 'Sam Rivera · sam@example.test', csrf: 'fictional-preview-csrf' }
const importing = { id: 'fictional-import', status: 'indexing', profileReady: true, processed: 412, total: 1005, statusUrl: '/imports/fictional-import/status' }
const indexed = { ...importing, status: 'indexed', processed: 1005 }
const profile = {
  name: 'Sam Rivera',
  headline: 'Partnerships lead · climate and energy',
  positions: [
    { title: 'Head of Partnerships', company: 'Meridian Grid', startDate: '2022', endDate: 'Present', description: 'Building partnerships between cities, utilities and climate companies.' },
    { title: 'Program Director', company: 'Community Solar Works', startDate: '2018', endDate: '2022', description: 'Led local solar programs with community organizations.' },
    { title: 'Partnerships Associate', company: 'Harbor Energy', startDate: '2015', endDate: '2018' },
  ],
  education: [{ institution: 'Westhaven University', degree: 'BA, Environmental Studies', startDate: '2011', endDate: '2015' }],
  skills: ['Partnerships', 'Climate strategy', 'Community energy', 'Program design', 'Research', 'Public speaking'],
}
const contacts = [
  ['Avery Lee', 'Director of Partnerships', 'Northwind Solar'],
  ['Morgan Singh', 'Climate Program Manager', 'Alder Climate'],
  ['Sasha Baptiste', 'General Counsel', 'Tern Analytics'],
  ['Arlo Whitlock', 'Founder', 'Northwind Solar'],
  ['Beck Vance', 'Research Scientist', 'Fieldstone Capital'],
  ['Clara Stavros', 'Investor', 'Juniper Bank'],
  ['Lena Ito', 'Data Scientist', 'Northwind Solar'],
  ['Lena Kimura', 'Director of Climate Programs', 'Lakeport'],
].map(([name, headline, company]) => ({ name, headline, company }))
const imports = [{ id: 'fictional-import', filename: 'Complete_LinkedInDataExport_Fictional.zip', status: 'indexed', accepted: 1005, indexed: 1005, sha256: '0123456789abcdef'.repeat(4) }]
const everyone = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Maya Chen', headline: 'Climate partnerships lead', company: 'Harbor Energy', location: 'Portland, Oregon' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Theo Brooks', headline: 'Founder', company: 'Cedar Labs', location: 'Denver, Colorado' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Elena Ruiz', headline: 'Program designer', company: 'Community Solar Works' },
]
const agentConfiguration = {
  mcpServers: { unlinked: { command: 'unlinked-mcp-server', env: { UNLINKED_API_KEY: 'fictional_fixture_not_a_credential' } } },
}
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const page = ({ title, content }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1>${content}</main></body></html>\n`

/** Write deterministic static previews; importing this module has no side effects. */
export async function buildPreviews(outDir) {
  const directory = resolve(outDir)
  const views = [
    ['join', renderJoin()],
    ['bring-export-ready', renderBringArchive(account)],
    ['bring-export-error', renderBringArchive({ ...account, state: 'error', errorMessage: 'That file is too large. Choose a ZIP or CSV under 64 MB, or try Connections.csv.' })],
    ['importing-profile-ready', renderImporting({ ...account, importJob: importing })],
    ['importing-indexed', renderImporting({ ...account, importJob: indexed })],
    ['own-profile-importing', renderOwnProfile({ ...account, profile, contacts, imports, importJob: importing })],
    ['own-profile-lookup-found', renderOwnProfile({ ...account, profile, linkedinLookup: { action: '/find-me' }, lookupResult: { status: 'found', profileName: 'Sam Rivera', headline: 'Partnerships lead · climate and energy', listedBy: 3, claimAction: '/claim-me?match=fictional-sam' } })],
    ['people-welcome', renderPeople({ ...account, state: 'welcome', own: contacts, everyone })],
    ['people-empty', renderPeople({ ...account, own: [], everyone: [] })],
    ['people-no-match', renderPeople({ ...account, query: 'ocean logistics', own: [], everyone: [] })],
    ['everyone-default', renderPeople({ ...account, scope: 'everyone', everyone, nextCursor: 'fictional-page-2' })],
    ['people-both-groups', renderPeople({ ...account, scope: 'own', own: contacts.map((contact, index) => ({ ...contact, ...(index === 0 ? { reason: 'Worked together on community energy.' } : {}) })), everyone })],
    ['everyone-unavailable', renderPeople({ ...account, scope: 'everyone', everyone: [], state: 'unavailable' })],
    ['everyone-no-match', renderPeople({ ...account, scope: 'everyone', everyone: [], query: 'ocean logistics' })],
    ['settings', renderSettings({ ...account, agentConfiguration, imports, grants: [{ id: 'fictional-grant' }] })],
  ]
  await mkdir(directory, { recursive: true })
  const files = []
  for (const [name, view] of views) {
    const file = join(directory, `${name}.html`)
    await writeFile(file, page(view), 'utf8')
    files.push(file)
  }
  return files
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error('Usage: node mcp-server/private-onboarding-preview.mjs <outDir>')
    process.exitCode = 1
  } else {
    for (const file of await buildPreviews(process.argv[2])) console.log(file)
  }
}
