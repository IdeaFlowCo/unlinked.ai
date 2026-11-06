// Who may see the connections a member's own LinkedIn export (or other
// listing) put on Unlinked (docs/connection-privacy.md). Two choices:
//
//   audience: who sees them at all
//     everyone       anyone, signed in or not (default)
//     members        anyone signed in to Unlinked
//     second_degree  the member's connections and their connections
//     connections    the member's own connections
//     only_me        nobody else
//   scope: what that audience sees
//     all            every connection (default)
//     shared         only the connections the viewer has too (mutuals)
//
// A connection is stored once, from the person whose export listed it. It is
// shown when any person who listed it allows it for this viewer, so one
// member's choice never hides a connection someone else published themselves.
// Everything not named in a snapshot's `connectionPrivacy` uses the default.
export const CONNECTION_AUDIENCES = Object.freeze(['everyone', 'members', 'second_degree', 'connections', 'only_me'])
export const CONNECTION_SCOPES = Object.freeze(['all', 'shared'])
export const DEFAULT_CONNECTION_PRIVACY = Object.freeze({ audience: 'everyone', scope: 'all' })

// A stored or submitted choice, normalized; null when it is not a valid one.
export function connectionPrivacyValue(value) {
  if (!value || typeof value !== 'object') return null
  const { audience, scope } = value
  if (!CONNECTION_AUDIENCES.includes(audience) || !CONNECTION_SCOPES.includes(scope)) return null
  // "Only you" has nothing left to narrow.
  return Object.freeze({ audience, scope: audience === 'only_me' ? 'all' : scope })
}
export const isDefaultConnectionPrivacy = value => value.audience === DEFAULT_CONNECTION_PRIVACY.audience && value.scope === DEFAULT_CONNECTION_PRIVACY.scope

// Plain-language labels, shared by the import form and Settings.
export const CONNECTION_AUDIENCE_LABELS = Object.freeze({
  everyone: 'Everyone (public)',
  members: 'People signed in to Unlinked',
  second_degree: 'Your connections and their connections',
  connections: 'Only your connections',
  only_me: 'Only you',
})
export const CONNECTION_SCOPE_LABELS = Object.freeze({
  all: 'All your connections',
  shared: 'Only the connections you have in common',
})
export function describeConnectionPrivacy(value) {
  const choice = connectionPrivacyValue(value) ?? DEFAULT_CONNECTION_PRIVACY
  if (choice.audience === 'only_me') return 'Only you can see your connections.'
  if (isDefaultConnectionPrivacy(choice)) return 'Anyone can see your connections.'
  const who = { everyone: 'Anyone', members: 'People signed in to Unlinked', second_degree: 'Your connections and their connections', connections: 'Your connections' }[choice.audience]
  return choice.scope === 'shared' ? `${who} can see the connections you have in common with them.` : `${who} can see all your connections.`
}

// Policies keyed by published profile id, as carried by a snapshot. Invalid or
// default entries are dropped; an id that is not published is ignored.
export function connectionPolicies(value, known) {
  const policies = new Map()
  if (value === undefined || value === null) return policies
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('connection_privacy_invalid')
  for (const [id, entry] of Object.entries(value)) {
    const choice = connectionPrivacyValue(entry)
    if (!choice) throw Error('connection_privacy_invalid')
    if ((!known || known(id)) && !isDefaultConnectionPrivacy(choice)) policies.set(id, choice)
  }
  return policies
}

// The connections visible to one viewer (docs/connection-privacy.md).
// `connected` is the whole symmetric graph (id -> Set); `listedBy(a, b)` says
// whether a's own listing holds the a–b connection (an export row, or an
// accepted invitation, which both people listed). `viewer` is
// { id?: published profile id, signedIn: bool }; missing means anonymous.
//
// Relationships are only ever taken from the owner's side: you are someone's
// connection when THEIR list names you, never because your own upload names
// them. Anyone can upload a file listing anyone, so a self-made list must not
// open someone else's private connections.
export function createConnectionVisibility({ policies, connected, listedBy, viewer }) {
  const signedIn = viewer?.signedIn === true
  const self = signedIn && typeof viewer.id === 'string' ? viewer.id : null
  const within = new Map()
  const neighbors = id => connected.get(id) ?? new Set()
  // Second degree: the owner listed you, or listed someone who listed you.
  const nearOwner = owner => {
    if (!within.has(owner)) {
      let near = listedBy(owner, self)
      if (!near) for (const via of neighbors(owner)) if (listedBy(owner, via) && listedBy(via, self)) { near = true; break }
      within.set(owner, near)
    }
    return within.get(owner)
  }
  const audienceAllows = (owner, policy) => {
    switch (policy.audience) {
      case 'everyone': return true
      case 'members': return signedIn
      case 'connections': return Boolean(self) && listedBy(owner, self)
      case 'second_degree': return Boolean(self) && nearOwner(owner)
      default: return false
    }
  }
  // Whether `owner`'s choice lets this viewer see owner's connection to `other`.
  // "In common" means `other` vouches for the viewer: `other`'s own list names
  // them (an accepted invitation or request counts). The viewer's own list
  // never counts, or uploading a list of everyone would reveal everything.
  const allowedBy = (owner, other) => {
    if (owner === self) return true
    const policy = policies.get(owner)
    if (!policy) return true
    if (!audienceAllows(owner, policy)) return false
    return policy.scope === 'all' || other === self || (Boolean(self) && listedBy(other, self))
  }
  // Shown on `page`'s profile: page's own choice allows it, and someone who
  // listed the connection allows it. So a private importer's list stays off
  // the profiles of the people it imported, and a member's own choice governs
  // their own page even for connections others listed.
  const visible = (page, other) => {
    if (!policies.size) return true
    if (!allowedBy(page, other)) return false
    return listedBy(page, other) || (listedBy(other, page) && allowedBy(other, page))
  }
  return { visible, restricted: policies.size > 0 }
}
