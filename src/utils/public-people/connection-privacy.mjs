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

// The connections visible to one viewer. `connected` is the whole symmetric
// graph (id -> Set), `listedBy(a, b)` says whether a's own listing holds the
// a–b connection. `viewer` is { id?: published profile id, signedIn: bool,
// known?: Set of published ids the viewer is connected to through their own
// private network }. A missing viewer is an anonymous visitor.
export function createConnectionVisibility({ policies, connected, listedBy, viewer }) {
  const signedIn = viewer?.signedIn === true
  const self = signedIn && typeof viewer.id === 'string' ? viewer.id : null
  const mine = new Set([...(self ? connected.get(self) ?? [] : []), ...(signedIn && viewer.known instanceof Set ? viewer.known : [])])
  const within = new Map()
  const audienceAllows = (owner, policy) => {
    switch (policy.audience) {
      case 'everyone': return true
      case 'members': return signedIn
      case 'connections': return Boolean(self) && (connected.get(owner)?.has(self) ?? false)
      case 'second_degree': {
        if (!self) return false
        if (!within.has(owner)) {
          const theirs = connected.get(owner) ?? new Set()
          let near = theirs.has(self)
          if (!near) for (const id of mine) if (theirs.has(id)) { near = true; break }
          within.set(owner, near)
        }
        return within.get(owner)
      }
      default: return false
    }
  }
  // Whether `owner`'s own listing of `other` may be shown.
  const allowedBy = (owner, other) => {
    if (owner === self) return true
    const policy = policies.get(owner)
    if (!policy) return true
    if (!audienceAllows(owner, policy)) return false
    return policy.scope === 'all' || other === self || mine.has(other)
  }
  const visible = (a, b) => {
    if (!policies.size) return true
    return (listedBy(a, b) && allowedBy(a, b)) || (listedBy(b, a) && allowedBy(b, a))
  }
  return { visible, restricted: policies.size > 0 }
}
