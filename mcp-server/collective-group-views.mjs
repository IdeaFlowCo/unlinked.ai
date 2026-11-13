import { renderPageShell } from './private-onboarding-views.mjs'
import { profilePath } from '../src/utils/public-people/profile-handles.mjs'
import { openChatProfileMessageUrl, unlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'
import { flyerInvitePath, FLYER_LIMITS, groupInvitePath } from './collective-groups.mjs'

const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const field = (name, value) => `<input type="hidden" name="${h(name)}" value="${h(value)}">`
const form = (path, csrf, label, fields = '', style = '') => `<form method="post" action="${h(path)}">${field('csrf', csrf)}${fields}<button class="sm ${style}" type="submit">${h(label)}</button></form>`
const back = (path, label) => `<p class="small"><a href="${h(path)}">← ${h(label)}</a></p>`
const title = (name, text) => `<h1 class="hq">${h(name)}</h1>${text ? `<p class="lead">${h(text)}</p>` : ''}`
// Follow system dark on this surface until the shared appearance control is
// present. Its explicit choices take precedence once the shell supplies them.
const style = `<style>
.unlinked-onboarding .collective-groups .card>h2:first-child{margin-top:0}
.unlinked-onboarding .collective-groups .card>p:last-child{margin-bottom:0}
@media(prefers-color-scheme:dark){
  html:not([data-appearance]) body:has(.collective-groups){background:#11141d;color-scheme:dark}
  html:not([data-appearance]) .unlinked-onboarding:has(.collective-groups){
    --brand:#5961d6;--brand-d:#b2b9ff;--tint:#282e50;--page:#11141d;--surface:#1b202c;
    --fg:#edf0f7;--muted:#a5afc2;--line:#ffffff1a;--line2:#505a70;
  }
  html:not([data-appearance]) .unlinked-onboarding:has(.collective-groups) :is(.card,.panel,.list-rows>li,.quiet,.button.sec,input[type=text],.header-search input[type=search],.omni-panel,.me-panel,.me>summary){
    background:var(--surface);
  }
  html:not([data-appearance]) .unlinked-onboarding:has(.collective-groups) .notice.error{color:#ffb4b0;background:#402629;border-color:#ae615f}
}
</style>`
const shell = (chrome, name, content) => renderPageShell(name, `${style}<section class="narrow wide collective-groups">${content}</section>`, { ...chrome, active: 'lists' })
const pathFor = id => `/groups/${id}`
const date = value => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(value) + ' UTC'
const profileLink = (id, name) => id ? `<a href="${h(profilePath(id))}">${h(name)}</a>` : h(name)
const chat = (id, label) => {
  const profile = id && unlinkedProfileContext(id)
  return profile ? `<a class="button sec sm" href="${h(openChatProfileMessageUrl(profile))}" target="_blank" rel="noopener noreferrer">${h(label)} ↗</a>` : ''
}
const profiles = rows => rows.length ? `<ul class="list-rows">${rows.map(row => `<li><b>${profileLink(row.id, row.name)}</b>${row.headline ? `<p class="small">${h(row.headline)}</p>` : ''}</li>`).join('')}</ul>` : '<p>No listed public profiles are available.</p>'
const card = (heading, content) => `<section class="card sec"><h2>${h(heading)}</h2>${content}</section>`
const approvalFields = '<label>Join policy<select name="mode"><option value="join">Join after confirmation</option><option value="approval">Organizer approval</option></select></label>'

function renderFlyerManagement(group, csrf, origin) {
  const base = pathFor(group.id) + '/flyer'
  const flyer = group.flyer
  if (!flyer?.active) {
    const capacity = `<label>Group capacity (including you)<input name="capacity" type="number" min="${Math.max(2, group.members.length + 1)}" max="${FLYER_LIMITS.seats}" value="${Math.max(group.capacity ?? 0, 100)}" required></label>`
    return card('Flyer invitation', '<p class="small">Create a reusable link for your cohort. It expires after 180 days and can be revoked.</p>' +
      form(base, csrf, 'Create flyer link', capacity + approvalFields))
  }
  const url = new URL(flyerInvitePath(group.id, flyer.id), origin).href
  const pending = flyer.requests.map(request => {
    const action = `${base}/${flyer.id}/requests/${request.id}`
    return `<article><h3>${profileLink(request.profileId, request.name)}</h3><div class="connection-actions">${form(action, csrf, 'Approve', field('decision', 'approve'))}${form(action, csrf, 'Decline', field('decision', 'decline'), 'quiet')}</div></article>`
  }).join('')
  return card('Flyer invitation', `<p class="small">Expires ${date(flyer.expiresAt)} · ${group.members.length + 1} of ${group.capacity} seats used · ${flyer.approval ? 'Organizer approval' : 'Join after confirmation'}</p><label>Flyer join link<input type="text" readonly value="${h(url)}"></label>` +
    form(base + '/' + flyer.id + '/revoke', csrf, 'Revoke flyer link', '', 'quiet') + (pending ? `<h3>Join requests</h3><div class="panel list">${pending}</div>` : ''))
}

export function renderFlyerInvitation(chrome, invitation, path, state = null, memberPath) {
  let content
  if (state === 'member') content = `<p role="status">You’re a member of this collective network.</p><a class="button" href="${h(memberPath)}">Open group</a>`
  else if (state === 'pending') content = '<p role="status">Request sent. The organizer will decide whether to admit you.</p>'
  else content = chrome.csrf
    ? '<p>Joining gives you access to the group and the lists its organizer has chosen to share. Your lists and imported contacts stay private.</p>' +
      form(path, chrome.csrf, 'Join this group', field('decision', 'join'))
    : `<p>Sign in or create an Unlinked account to decide whether to join.</p><a class="button" href="/login?next=${encodeURIComponent(path)}">Continue with Ideaflow</a>`
  return renderPageShell(invitation.title, `${style}<section class="narrow collective-groups">${title(invitation.title, 'Collective network invitation')}${card('Join the group', content)}</section>`,
    { ...chrome, active: 'lists', signInInBody: true })
}

export function renderGroups(chrome, { groups, invites }) {
  const pending = invites.map(invite => `<article><h3><a href="${groupInvitePath(invite.group.id, invite.id)}">${h(invite.group.name)}</a></h3><p class="small">Review invitation · Expires ${date(invite.expiresAt)}</p></article>`).join('')
  const rows = groups.map(group => `<article><h3><a href="${pathFor(group.id)}">${h(group.name)}</a></h3><p class="small">${group.organizer ? 'Organizer' : 'Member'}</p></article>`).join('')
  const create = form('/groups', chrome.csrf, 'Create private group', '<label>Group name<input name="name" maxlength="100" required placeholder="e.g. Climate founders"></label>')
  return shell(chrome, 'Collective network', back('/lists', 'Lists') + title('Collective network', 'Share selected lists with a private group.') +
    (pending ? card('Invitations', `<div class="panel list">${pending}</div>`) : '') +
    card('Your groups', rows ? `<div class="panel list">${rows}</div>` : '<p>You aren’t in any groups yet.</p>') +
    card('Start a group', '<p class="small">Invite people individually. They decide whether to join, and every list is shared separately.</p>' + create))
}

export function renderGroupAbout(group) {
  return (group.description ? `<p class="group-description" style="white-space:pre-wrap;overflow-wrap:anywhere">${h(group.description)}</p>` : '') +
    (group.chatUrl ? `<p><a class="button sec" href="${h(group.chatUrl)}" target="_blank" rel="noopener noreferrer">Join the WhatsApp group chat ↗</a></p>` : '') +
    (group.openChatUrl ? `<p><a class="button sec" href="${h(group.openChatUrl)}" target="_blank" rel="noopener noreferrer">Join the OpenChat group chat ↗</a></p>` : '')
}
export function renderGroup(chrome, group, origin) {
  const base = pathFor(group.id), csrf = chrome.csrf
  const shares = group.shares.map(share => `<article><h3><a href="${base}/lists/${share.id}">${h(share.name)}</a></h3>${group.organizer ? form(`${base}/lists/${share.id}/revoke`, csrf, 'Revoke list access', '', 'quiet') : ''}</article>`).join('')
  const list = card('Shared lists', (shares ? `<div class="panel list">${shares}</div>` : '<p>No lists have been shared yet.</p>') +
    (group.organizer ? `<p><a class="button sec sm" href="${base}/select">Choose a list to share</a></p>` : ''))
  const inviteForm = form(base + '/invite', csrf, 'Create invitation', '<label>Member’s Unlinked profile link<input name="profile" type="text" inputmode="url" required maxlength="1600" placeholder="https://www.unlinked.ai/people/…"></label>')
  const invites = group.organizer ? group.invites.map(invite => {
    const url = new URL(groupInvitePath(group.id, invite.id), origin).href
    return `<article><h3>${profileLink(invite.profileId, invite.name)}</h3><p class="small">Pending · Expires ${date(invite.expiresAt)}</p><label>Invitation link<input type="text" readonly value="${h(url)}"></label><div class="connection-actions">${chat(invite.profileId, 'Open OpenChat')}${form(`${groupInvitePath(group.id, invite.id)}/revoke`, csrf, 'Cancel invitation', '', 'quiet')}</div></article>`
  }).join('') : ''
  const members = group.organizer ? group.members.map(member => `<article><h3>${profileLink(member.profileId, member.name)}</h3>${form(`${base}/members/${member.id}/remove`, csrf, 'Remove member', '', 'quiet')}</article>`).join('') : ''
  return shell(chrome, group.name, back('/groups', 'Collective network') + title(group.name, 'Private group · ' + (group.organizer ? 'Organizer' : 'Member')) +
    card('About this group', renderGroupAbout(group) + (group.organizer ? `<details><summary>Edit description and group chat</summary><p class="small">Visible to group members. Each chat link opens a separate invitation you can choose to accept.</p>${form(base + '/about', csrf, 'Save group information', `<label>Group description<textarea name="description" maxlength="2000" rows="5">${h(group.description)}</textarea></label><label>WhatsApp invitation link<input name="chatUrl" type="url" maxlength="500" value="${h(group.chatUrl)}" placeholder="https://chat.whatsapp.com/…"></label><label>OpenChat invitation link<input name="openChatUrl" type="url" maxlength="500" value="${h(group.openChatUrl)}" placeholder="https://chat.ideaflow.app/i/…"></label>`)}</details>` : '')) +
    card('Your community', `<p><a class="button" href="${base}/community">People, asks and offers →</a></p><p><a href="${base}/welcome">Add or update your introduction</a></p>`) + list + (group.organizer ? renderFlyerManagement(group, csrf, origin) + card('Members', (members ? `<div class="panel list">${members}</div>` : '<p>You’re the only member so far.</p>')) +
    card('Invite a member', '<p class="small">Use the profile link of an existing Unlinked member. Creating an invitation sends nothing. To share the link, copy it into an OpenChat conversation.</p>' + inviteForm +
      (invites ? `<div class="panel list">${invites}</div>` : '')) : `<p>${chat(group.organizerProfileId, 'Message the organizer')}</p>`))
}

export function renderGroupInvitation(chrome, invitation, invitePath) {
  return shell(chrome, 'Group invitation', back('/groups', 'Collective network') + title(invitation.group.name, 'You have a private group invitation.') +
    card('Decide whether to join', `<p>Accepting adds you to this group and gives you access to the lists the organizer has chosen to share. Your lists and imported contacts stay private.</p><p class="small">Expires ${date(invitation.expiresAt)}</p><div class="connection-actions">${form(invitePath, chrome.csrf, 'Accept invitation', field('decision', 'accept'))}${form(invitePath, chrome.csrf, 'Decline', field('decision', 'decline'), 'quiet')}</div>`))
}

export function renderGroupSelection(chrome, group, choices) {
  const base = pathFor(group.id), path = base + '/select'
  const rows = choices.choices.map(list => `<article><h3><a href="${path}?source=${encodeURIComponent(list.source)}">${h(list.name)}</a></h3><p class="small">${h(list.type)} · Review what will be shared</p></article>`).join('')
  return shell(chrome, 'Choose a list', back(base, group.name) + title('Choose a list', 'Review one list before giving group members access.') +
    (rows ? `<div class="panel list">${rows}</div>` : '<p>No lists to choose from. <a href="/lists">Open Lists</a>.</p>') +
    (choices.nextCursor ? `<p><a href="${path}?after=${encodeURIComponent(choices.nextCursor)}">More private lists →</a></p>` : ''))
}

export function renderGroupSharePreview(chrome, group, selection) {
  const path = pathFor(group.id) + '/select'
  return shell(chrome, 'Review list access', back(path, 'Choose another list') + title(selection.name, 'Review what members of ' + group.name + ' will see.') +
    card('Visible to this group', '<p>The list name and the listed public profiles shown here are shared. The original search, private contacts, notes, and future additions stay private.</p>' +
      profiles(selection.profiles) + (selection.profiles.length ? form(path, chrome.csrf, 'Share with this group', field('source', selection.source) + field('proof', selection.proof)) : '<p>Choose a list with listed public profiles to share.</p>')))
}

export function renderGroupSharedList(chrome, { group, share, profiles: rows }) {
  return shell(chrome, share.name, back(pathFor(group.id), group.name) + title(share.name, 'Shared with ' + group.name) +
    card('People in this list', profiles(rows)))
}

export function renderGroupError(chrome, message, backPath = '/groups') {
  return shell(chrome, 'Collective network', title('Collective network') + `<p class="notice error" role="alert">${h(message)}</p>` + back(backPath, 'Go back'))
}
