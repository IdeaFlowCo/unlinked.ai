import { createHash } from 'node:crypto'

// The People directory as the Unlinked iOS app shows it (unlinked-ac9.3,
// App Store guideline 5.1.1(viii); docs/ios-app-directory.md): only people who
// joined Unlinked themselves. Profiles imported from members' LinkedIn exports
// ("Not on Unlinked") and recovered legacy accounts awaiting a claim are left
// out, with every connection that touches them. A signed-in member still sees
// their own imported people through their own network, never through this index.

// The iOS shell adds `UnlinkediOS/<version>` to WebKit's user agent
// (unlinked-ios-testflight, Browser.swift). Anything else gets the website.
export const IOS_APP_USER_AGENT = /\bUnlinkediOS\/\d/
export const iosAppUserAgent = value => typeof value === 'string' && value.length <= 1024 && IOS_APP_USER_AGENT.test(value)

const hash = value => createHash('sha256').update(value).digest('hex')

export function membersOnlySnapshot(snapshot) {
  const members = new Set(Array.isArray(snapshot?.members) ? snapshot.members : [])
  // A snapshot that does not name its members has none to show.
  const profiles = Array.isArray(snapshot?.profiles) ? snapshot.profiles.filter(profile => members.has(profile?.id)) : []
  const kept = new Set(profiles.map(profile => profile.id))
  const connections = Array.isArray(snapshot?.connections) ? snapshot.connections.filter(edge => kept.has(edge?.fromId) && kept.has(edge?.toId)) : []
  const aliases = snapshot?.aliases && typeof snapshot.aliases === 'object' ? Object.fromEntries(Object.entries(snapshot.aliases).filter(([, to]) => kept.has(to))) : undefined
  const unlisted = Array.isArray(snapshot?.unlisted) ? snapshot.unlisted.filter(entry => kept.has(entry?.id)) : undefined
  return {
    ...snapshot,
    // Its own revision, so a compiled index, cursor or cache of the whole
    // directory is never reused for this one (and the reverse). Bounded length.
    revision: `members-only-v1:${hash(String(snapshot?.revision ?? '')).slice(0, 40)}`,
    profiles, connections, members: [...kept].sort(), legacyMembers: [],
    ...(aliases ? { aliases } : {}),
    ...(unlisted ? { unlisted } : {}),
  }
}

// A snapshot reader over `read` that returns the members-only directory.
// The last result is reused while the source returns the same object.
export function createMembersOnlySnapshotReader(read) {
  if (typeof read !== 'function') throw new TypeError('members_only_source_required')
  let last = null
  const filtered = async options => {
    const value = await read(options)
    if (last?.input === value) return last.output
    const output = membersOnlySnapshot(value)
    last = { input: value, output }
    return output
  }
  // Its revision hashes the source's, so it identifies content exactly when the source's does.
  filtered.revisionIdentifiesContent = read.revisionIdentifiesContent === true
  return filtered
}
