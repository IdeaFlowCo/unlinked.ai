import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderListsDirectory } from '../mcp-server/private-onboarding-views.mjs'
import { ONBOARDING_FONT_HREF } from '../mcp-server/private-onboarding-style.mjs'
import { groupInvitePath } from '../mcp-server/collective-groups.mjs'
import { renderGroup, renderGroups, renderGroupInvitation, renderGroupSharedList, renderGroupSharePreview, renderFlyerInvitation } from '../mcp-server/collective-group-views.mjs'

if (!process.argv[2]) throw Error('Usage: node scripts/preview-collective-network.mjs <output-directory>')
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })

const alice = { accountLabel: 'Maya Chen', displayName: 'Maya Chen', csrf: 'fictional-preview' }
const bob = { accountLabel: 'Theo Brooks', displayName: 'Theo Brooks', csrf: 'fictional-preview' }
const uuid = digit => `00000000-0000-4000-8000-00000000000${digit}`
const group = { id: uuid(1), name: 'Climate founders', organizer: true, organizerProfileId: 'maya-chen' }
const invite = { id: uuid(2), name: 'Theo Brooks', profileId: 'theo-brooks', expiresAt: Date.UTC(2026, 10, 17) }
const share = { id: uuid(3), name: 'Founder introductions' }
const rows = [
  { id: 'avery-lee', name: 'Avery Lee', headline: 'Director of Partnerships · Northwind Solar' },
  { id: 'morgan-singh', name: 'Morgan Singh', headline: 'Founder · Alder Climate' },
  { id: 'sasha-baptiste', name: 'Sasha Baptiste', headline: 'General Counsel · Tern Analytics' },
]
const lists = { ...alice, privatePage: { lists: [{ id: 'fixture-list', name: share.name }] },
  saved: [{ id: uuid(4), name: 'Climate operators', refs: ['public:avery-lee'] }], groupsAvailable: true }
const pages = {
  lists: renderListsDirectory(lists),
  groups: renderGroups(alice, { groups: [group], invites: [] }),
  organizer: renderGroup(alice, { ...group, invites: [invite], members: [], shares: [share] }, 'https://www.unlinked.ai'),
  invitation: renderGroupInvitation(bob, { group, expiresAt: invite.expiresAt }, groupInvitePath(group.id, invite.id)),
  review: renderGroupSharePreview(alice, group, { name: share.name, profiles: rows, source: 'private:fixture-list', proof: 'fictional-review' }),
  shared: renderGroupSharedList(bob, { group, share, profiles: rows }),
  flyer: renderFlyerInvitation({}, { title: 'YC Fall 2026 collective network' }, `/groups/${uuid(1)}/join/${uuid(2)}?utm_content=yc_fall_2026_collective_v2`),
  'flyer-confirm': renderFlyerInvitation(bob, { title: 'YC Fall 2026 collective network' }, `/groups/${uuid(1)}/join/${uuid(2)}?utm_content=yc_fall_2026_collective_v2`),
}
for (const [name, view] of Object.entries(pages)) {
  await writeFile(resolve(output, name + '.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlinked · Fictional preview</title><link rel="stylesheet" href="${ONBOARDING_FONT_HREF}">${view.content}</html>`)
}
