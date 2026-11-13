// Private group navigation. A sparse member profile is not an unclaimed contact.
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c])
export const groupMemberPath = (groupId, memberId) => `/groups/${groupId}/community/${memberId}`
export const groupMemberStyle = `<style>
.group-members{list-style:none;margin:0;padding:0}.group-member{display:flex;align-items:center;gap:16px;padding:16px 0;border-top:1px solid var(--line);flex-wrap:wrap}.group-member:first-child{border-top:0}.group-member-main{flex:1;min-width:170px;overflow-wrap:anywhere}.group-member-main>a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}.group-member-main p{margin:0}.group-member-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.group-member-actions form{margin:0}.unlinked-onboarding .group-member-actions :is(a,button){min-height:44px;display:inline-flex;align-items:center}.group-profile-label{font-size:12px;font-weight:500;color:var(--muted)}
</style>`
export function groupMemberMessage(chrome, groupId, member, available = true) {
 if (member.self) return '<span class="small">You</span>'
 return available ? `<form method="post" action="/groups/${h(groupId)}/members/${h(member.id)}/message"><input type="hidden" name="csrf" value="${h(chrome.csrf)}"><button type="submit" class="sec sm" aria-label="Message ${h(member.name)} on OpenChat">Message</button></form>` : '<span class="small">Messaging unavailable</span>'
}
export function renderGroupMembers(chrome, groupId, members, available = true) {
 return groupMemberStyle + `<ul class="group-members">${members.map(member => `<li class="group-member"><div class="group-member-main"><a href="${h(groupMemberPath(groupId,member.id))}">${h(member.name)}</a><p class="small">${h(member.role)} · <span class="group-profile-label">Group profile</span></p></div><div class="group-member-actions">${groupMemberMessage(chrome,groupId,member,available)}</div></li>`).join('')}</ul>`
}
export function renderGroupsInCommon(groups) {
 return groups?.length ? `<section class="card"><h2>Groups in common</h2><p class="small">Private to you. Groups you both belong to.</p><ul>${groups.map(group=>`<li><a href="/groups/${h(group.urlKey??group.id)}">${h(group.name)}</a></li>`).join('')}</ul></section>` : ''
}
