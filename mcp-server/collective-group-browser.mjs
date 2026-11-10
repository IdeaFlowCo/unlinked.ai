import { parseUnlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'
import { GROUP_UUID, GroupError } from './collective-groups.mjs'
import { createCollectiveListProjection } from './collective-group-lists.mjs'
import { renderGroup, renderGroups, renderGroupError, renderGroupInvitation, renderGroupSelection, renderGroupSharedList, renderGroupSharePreview } from './collective-group-views.mjs'

const signInRoute = new RegExp(`^/groups/${GROUP_UUID}(?:/invites/${GROUP_UUID}|/lists/${GROUP_UUID})?$`)
const route = new RegExp(`^/groups/(${GROUP_UUID})(?:/(invite|select)|/(invites|members|lists)/(${GROUP_UUID})(?:/(revoke|remove))?)?$`)
export const isGroupPath = path => path === '/groups' || path.startsWith('/groups/')
export const groupReturnPath = path => path === '/groups' || signInRoute.test(path)
const fail = code => { throw new GroupError(code) }
const messages = {
  invalid_input: 'Refresh this page and try again.',
  invalid_name: 'Enter a group name up to 100 characters.',
  invalid_recipient: 'Use the profile link of an existing Unlinked member you can invite.',
  already_member: 'This person is already a member.',
  already_invited: 'This person already has a pending invitation.',
  already_shared: 'This list is already shared with the group.',
  group_full: 'This group has reached its limit. Remove an existing entry and try again.',
  list_unavailable: 'This list is no longer available. Choose another list.',
  list_too_large: 'This list is too large to review here. Choose a smaller list.',
  empty_list: 'Choose a list with listed public profiles to share.',
  review_changed: 'The list changed since you reviewed it. Review the list again before sharing.',
}

export function createGroupBrowser({ groups, privateLists, savedSearchLists, accountForProfile, ownProfileId, handleTarget, body }) {
  if (typeof accountForProfile !== 'function') throw new TypeError('collective_groups_account_resolution_required')
  return async ({ request, url, session, lookup, render, redirect }) => {
    const { pathname, searchParams, origin } = url
    const actor = session.owner
    const chrome = { accountLabel: session.accountLabel, displayName: session.displayName, csrf: session.csrf }
    const parsed = route.exec(pathname)
    const [ , groupId, action, collection, target, mutation ] = parsed ?? []
    const base = groupId ? `/groups/${groupId}` : '/groups'
    const projection = createCollectiveListProjection({ privateLists, savedSearchLists, lookup })
    const get = request.method === 'GET'
    const fields = async (...names) => {
      if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') fail('invalid_input')
      let input
      try { input = new URLSearchParams((await body(request, 4096)).toString('utf8')) } catch { fail('invalid_input') }
      if ([...input.keys()].length !== names.length + 1 || input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || names.some(name => input.getAll(name).length !== 1)) fail('invalid_input')
      return input
    }
    const organizer = async () => {
      const group = await groups.detail(actor, groupId)
      if (!group.organizer) fail('not_found')
      return group
    }
    try {
      if (pathname !== '/groups' && !parsed) fail('not_found')
      if (searchParams.size && !(get && action === 'select')) fail('not_found')
      if (pathname === '/groups') {
        if (get) return render(renderGroups(chrome, await groups.directory(actor)))
        const input = await fields('name')
        const group = await groups.create(actor, input.get('name'), await ownProfileId?.(actor))
        return redirect(`/groups/${group.id}`)
      }
      if (!action && !collection && get) return render(renderGroup(chrome, await groups.detail(actor, groupId), origin))
      if (action === 'invite' && !get) {
        const input = await fields('profile')
        await organizer()
        const context = parseUnlinkedProfileContext(input.get('profile'))
        if (!context) fail('invalid_recipient')
        const segment = decodeURIComponent(context.slice(context.lastIndexOf('/') + 1))
        const profile = (await lookup([handleTarget(segment)])).values().next().value
        const recipient = profile && await accountForProfile(profile.id)
        if (!recipient) fail('invalid_recipient')
        await groups.invite(actor, groupId, recipient, profile)
        return redirect(base)
      }
      if (action === 'select') {
        if (get) {
          const group = await organizer()
          if (searchParams.size > 1 || [...searchParams.keys()].some(key => !['source', 'after'].includes(key))) fail('invalid_input')
          const source = searchParams.get('source'), after = searchParams.get('after')
          if (after !== null && (!after || after.length > 512)) fail('invalid_input')
          return render(source === null ? renderGroupSelection(chrome, group, await projection.choices(actor, after ?? undefined)) :
            renderGroupSharePreview(chrome, group, await projection.preview(actor, groupId, source)))
        }
        const input = await fields('source', 'proof')
        await organizer()
        const selection = await projection.preview(actor, groupId, input.get('source'))
        if (selection.proof !== input.get('proof')) fail('review_changed')
        await groups.share(actor, groupId, selection)
        return redirect(base)
      }
      if (collection === 'invites' && !mutation) {
        if (get) return render(renderGroupInvitation(chrome, await groups.inspectInvite(actor, groupId, target), pathname))
        const input = await fields('decision')
        const decision = input.get('decision')
        await groups.respond(actor, groupId, target, decision)
        return redirect(decision === 'accept' ? base : '/groups')
      }
      if (collection === 'lists' && !mutation && get) return render(renderGroupSharedList(chrome, await groups.readShare(actor, groupId, target, projection.project)))
      if (!get && ((collection === 'invites' || collection === 'lists') && mutation === 'revoke' || collection === 'members' && mutation === 'remove')) {
        await fields()
        await groups.revoke(actor, groupId, { invites: 'invite', lists: 'share', members: 'member' }[collection], target)
        return redirect(base)
      }
      fail('not_found')
    } catch (error) {
      if (!(error instanceof GroupError)) return render(renderGroupError(chrome, 'This group page is temporarily unavailable. Please try again.'), 503)
      if (error.code === 'not_found') return render(renderGroupError(chrome, 'This group page or invitation is unavailable.'), 404)
      return render(renderGroupError(chrome, messages[error.code] ?? messages.invalid_input, base), error.code === 'review_changed' ? 409 : 400)
    }
  }
}
