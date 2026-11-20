import { askTheme, suggestAskHelpers } from './meet-asks.mjs'
import { displayPhone } from './contact-card.mjs'
import { renderPageShell, businessCard } from './private-onboarding-views.mjs'
import { qrSvg } from '../src/utils/qr-code.mjs'

const h = value => String(value ?? '').replace(/[&<>"']/g, key => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[key])
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${h(value)}">`
const button = text => `<button class="button">${text}</button>`
const safeLink = (url, text, style = 'sec') => `<a class="button ${style}" href="${h(url)}">${h(text)}</a>`
const external = (url, text) => `<a class="button sec" href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(text)}</a>`
const errorBox = error => error ? `<p class="meet-error" role="alert">${h(error)}</p>` : ''
const status = text => text ? `<p class="notice" role="status">${h(text)}</p>` : ''
const date = at => new Date(at).toISOString().slice(0, 16).replace('T', ' · ') + ' UTC'
const personName = contact => contact.name || 'Unnamed contact'
const check = (name, text, on = false) => `<label class="swap-check"><input type="checkbox" name="${name}" value="yes"${on ? ' checked' : ''}> <span>${h(text)}</span></label>`
const field = (name, label, options = {}) => {
  const { type = 'text', length = 180, value, placeholder = '', attr = '' } = options
  return `<label class="swap-field">${h(label)}<input name="${name}" type="${type}" maxlength="${length}" value="${h(value)}" placeholder="${h(placeholder)}" ${attr}></label>`
}
const mic = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5v.8a6.5 6.5 0 0 0 13 0v-.8M12 18v3.5m-3 0h6"/></svg>'
const style = `<style>
.meet-swap{max-width:580px}.meet-workspace{max-width:910px}.meet-swap,.meet-workspace{margin:0 auto}
.meet-swap .hq,.meet-workspace .hq{margin:0 0 .3em}.meet-kicker{color:var(--brand);font-size:.83rem;font-weight:650;letter-spacing:.045em;margin:0 0 .5rem}
.meet-panel{padding:clamp(16px,4vw,28px);margin:16px 0;overflow-wrap:anywhere}.meet-panel h2{margin-top:0}
.meet-host{margin:0 0 14px}.meet-host .bcard{padding:0;background:none;border:0;box-shadow:none}.meet-host .bc-main{padding:0}.meet-host .bc-name{font-size:1.1rem}
.unlinked-onboarding .meet-form{display:grid;gap:12px;margin:0}.unlinked-onboarding .meet-form .actions{margin:0}
.unlinked-onboarding .meet-panel .swap-field{display:grid;gap:5px;font-size:.91rem;font-weight:600;min-width:0;margin:0}
.unlinked-onboarding .meet-panel .swap-field input{margin:0;font-weight:400}
.unlinked-onboarding .meet-panel .meet-options,.unlinked-onboarding .meet-panel .meet-channel{margin:0}
.meet-extras[open] summary{margin-bottom:10px}.meet-extras fieldset{margin-top:10px}
.meet-extras .meet-grid{margin-top:8px}
.swap-field input,.meet-choice select,.ask-input{width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line2);border-radius:8px;background:var(--page);color:var(--fg);font:inherit;font-size:16px}
.swap-field input:focus,.meet-choice select:focus,.ask-input:focus{outline:2px solid var(--brand);outline-offset:1px}
.meet-options summary,.meet-panel summary{cursor:pointer;color:var(--brand-d);font-size:.91rem;font-weight:600}
.meet-optional{color:var(--muted);font-weight:400}.meet-panel fieldset{padding:0;border:0;margin:0;min-width:0}
.meet-panel legend{padding:0;font-weight:650;margin-bottom:8px}.meet-panel fieldset p{margin:0 0 10px}
.meet-chips{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}.meet-channel{min-width:0}
.meet-channel summary{list-style:none;padding:5px 10px;border-radius:100px;border:1px solid var(--line2)}
.meet-channel summary::-webkit-details-marker{display:none}.meet-channel[open] summary{background:var(--tint);width:max-content;margin-bottom:6px}
.meet-channel[open]{flex-basis:100%}.meet-channel .swap-field{max-width:100%}
.unlinked-onboarding .meet-panel .swap-check{display:flex;align-items:flex-start;gap:6px;font-size:.92rem;line-height:1.35;margin:0}.unlinked-onboarding .meet-panel .swap-check input{width:18px;height:18px;flex:none;accent-color:var(--brand);margin:0 2px 0 0}
.meet-submit{display:grid;gap:8px;margin-top:2px}.meet-submit .button{width:100%;min-height:46px}
.meet-submit p,.meet-panel .small{margin:0}.meet-error{font-size:.92rem;color:#a23737;margin:0}
.meet-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.meet-panel .meet-grid{align-items:start}
.meet-list{list-style:none;margin:0;padding:0}.meet-list>li{padding:13px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.meet-list>li:last-child{border-bottom:0}.meet-list p{margin:5px 0}.meet-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.meet-links{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:12px 0}
.meet-time,.meet-tag{font-size:.8rem;color:var(--muted)}.meet-tag{padding:3px 7px;background:var(--page);border:1px solid var(--line);border-radius:99px}
.meet-qr{display:grid;grid-template-columns:132px minmax(0,1fr);gap:16px;align-items:center;overflow-wrap:anywhere}.meet-qr svg{width:100%;height:auto;background:#fff}
.meet-filters{display:flex;align-items:end;gap:8px;flex-wrap:wrap}.meet-filters label{flex:1}
.meet-ask-state{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}.meet-ask-state select{padding:4px;max-width:130px;font:inherit;background:var(--page);color:inherit;border-radius:6px;border:1px solid var(--line2)}
.meet-agent{position:fixed;right:20px;bottom:20px;z-index:40;max-width:min(360px,calc(100vw - 32px));margin:0}
.meet-agent summary{margin-left:auto;list-style:none;display:flex;align-items:center;gap:7px;width:max-content;min-height:42px;cursor:pointer;box-shadow:0 3px 18px #1011262b}
.meet-agent summary::-webkit-details-marker{display:none}.meet-agent[open] summary{margin-bottom:7px}
.meet-agent .meet-panel{margin:0;padding:14px;box-shadow:0 6px 24px #10112633}
.meet-agent input,.meet-agent .meet-form{width:100%;min-width:0}
.meet-agent .meet-links button{margin:0}.meet-agent .meet-links{margin:0}
@media(max-width:649px){.meet-agent{bottom:max(14px,env(safe-area-inset-bottom));right:14px}.meet-agent-label{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}.meet-agent summary{min-width:44px;justify-content:center}.meet-grid{grid-template-columns:1fr}.meet-qr{grid-template-columns:95px minmax(0,1fr)}}
</style>`

export const meetPath = link => '/m/' + link.token + '?' + new URLSearchParams({ e: link.event, ...(link.group ? { g: link.group.id } : {}) })
const shell = (chrome, title, content, narrow = false) => ({
  ...renderPageShell(title, style + `<section class="${narrow ? 'meet-swap' : 'meet-workspace'}">${content}</section>`, chrome),
  privateGroup: true,
})
const workspaceNav = '<nav class="meet-links" aria-label="Meet workspace"><a href="/swaps">Swaps</a> · <a href="/swaps/invites">Invite list</a> · <a href="/network/asks">Network asks</a> · <a href="/swaps/links">My QR links</a></nav>'

export function renderSwap({ card, link, submission, values, error }) {
  const get = name => values?.get(name) ?? ''
  const options = [
    ['instagram', 'Instagram', '@handle'], ['x', 'X', '@handle'], ['linkedin', 'LinkedIn', 'linkedin.com/in/your-name'], ['email', 'Email', 'you@example.com'],
  ]
  const expanded = options.some(([name]) => get(name))
  const extras = ['name', 'about', 'ask'].some(key => get(key))
  const name = card.name.split(' ')[0]
  const title = `Swap numbers with ${name}`
  return shell({}, title, `<div class="card meet-panel"><div class="meet-host">${businessCard({ ...card, heading: 'p' })}</div>
  ${link.label ? `<p class="meet-kicker">${h(link.label)}</p>` : ''}<h1 class="hq">${h(title)}</h1>
  <p class="lead">Share one way to stay in touch.</p>${errorBox(error)}
  <form class="meet-form" action="${h(meetPath(link))}" method="post" novalidate>
  ${hidden('submission', submission)}
  ${field('phone', 'Phone number', { type: 'tel', length: 40, value: get('phone'), placeholder: '+1 415 555 0123', attr: 'autocomplete="tel" inputmode="tel" autofocus' })}
  <details class="meet-options"${expanded ? ' open' : ''}><summary>Add another way to reach you</summary><div class="meet-chips">${options.map(([key, label, placeholder]) =>
    `<details class="meet-channel"${get(key) ? ' open' : ''}><summary>${label}</summary>${field(key, key === 'email' ? 'Email address' : label + ' handle or link', { type: key === 'email' ? 'email' : 'text', length: key === 'email' ? 254 : 300, value: get(key), placeholder,
      attr: key === 'email' ? 'autocomplete="email"' : 'autocapitalize="none" spellcheck="false"' })}</details>`).join('')}</div></details>
  <details class="meet-options meet-extras"${extras ? ' open' : ''}><summary>Skip the small talk <span class="meet-optional">· optional</span></summary>
  <p class="small">I already know I want to stay in touch.</p>
  <fieldset aria-label="Optional introductions">
  ${field('name', 'Name (optional)', { length: 100, value: get('name'), attr: 'autocomplete="name"' })}
  <div class="meet-grid">${field('about', 'One thing about you', { value: get('about'), placeholder: 'Climbing, building sensors' })}
  ${field('ask', 'What would help right now?', { value: get('ask'), placeholder: 'An intro to a cofounder' })}</div></fieldset></details>
  ${check('invite', `Invite me to ${name}’s future gatherings`, get('invite') === 'yes')}
  ${link.group ? check('join', 'I’d like to join ' + link.group.name, get('join') === 'yes') : ''}
  <div class="meet-submit">${button('Swap')}<p class="small">${h(name)} will save what you share privately and may text or message you.</p></div></form></div>`, true)
}

export function renderSwapSuccess({ link, card, joined }) {
  const name = card.name.split(' ')[0]
  return shell({}, `Contact card for ${name}`, `<div class="card meet-panel"><p class="meet-kicker">Swap complete</p><h1 class="hq">Stay in touch with ${h(name)}</h1>
  <p class="lead">Your details are with ${h(name)}.</p>${businessCard({ ...card, heading: 'h2' })}
  <div class="meet-links">${safeLink(meetPath(link) + '&vcard=1', `Add ${name} to contacts`, '')}
  ${card.phone ? safeLink('sms:' + card.phone, 'Text ' + name) : ''}${card.email ? safeLink('mailto:' + card.email, 'Email') : ''}
  ${link.instagram ? external('https://www.instagram.com/' + link.instagram + '/', 'Instagram') : ''}
  ${link.x ? external('https://x.com/' + link.x, 'X') : ''}</div>
  ${joined && link.group ? `<p class="small">Finish joining ${h(link.group.name)} through its Unlinked invitation.</p><div class="meet-links">${safeLink(link.group.href, 'Continue to group')}</div>` : ''}
  </div>`, true)
}

export function renderMeetLinks(chrome, { links, groups, ownerCard, origin, error, notice }) {
  return shell(chrome, 'My swap QR links', `${workspaceNav}<h1 class="hq">My QR links</h1><p class="lead">Give people a quick way to share their contact details when you meet.</p>
  <div class="card meet-panel"><h2>Create a swap QR</h2>${errorBox(error)}${status(notice)}
  ${ownerCard?.phone ? `<form class="meet-form" action="/swaps/links" method="post">${hidden('csrf', chrome.csrf)}${hidden('action', 'create')}
  ${field('label', 'Event', { length: 80, placeholder: 'Community dinner', attr: 'required' })}
  <div class="meet-grid">${field('instagram', 'Share your Instagram (optional)', { length: 300, placeholder: '@handle' })}
  ${field('x', 'Share your X (optional)', { length: 300, placeholder: '@handle' })}</div>
  ${groups.length ? `<label class="swap-field meet-choice">Invite to a group (optional)<select name="group"><option value="">Choose a group</option>${groups.map(group => `<option value="${h(group.id)}">${h(group.name)}</option>`).join('')}</select></label>` : ''}
  <p class="small">A swap shares the phone number and details you’ve enabled on your <a href="/card/edit">contact card</a>.</p>
  <div class="actions">${button('Create QR')}</div></form>` : '<p>Enable a shared phone number on your <a href="/card/edit">contact card</a> to create a swap QR.</p>'}</div>
  ${links.map(link => {
    const url = origin + meetPath(link)
    return `<div class="card meet-panel meet-qr">${qrSvg(url, { label: 'Swap QR for ' + link.label })}<div><h2>${h(link.label)}</h2>${link.group ? `<p class="small">Group invitation: ${h(link.group.name)}</p>` : ''}
    <p><a href="${h(url)}">${h(url)}</a></p>
    <form method="post" action="/swaps/links">${hidden('csrf', chrome.csrf)}${hidden('action', 'disable')}${hidden('event', link.event)}<button class="button sec">Turn off link</button></form></div></div>`
  }).join('')}`)
}

export function renderSwaps(chrome, { data, invited, filter, eventOptions }) {
  const action = invited ? '/swaps/invites' : '/swaps'
  const title = invited ? 'Invite list' : 'Recent swaps'
  const entries = data.encounters.filter(row => (!invited || row.invite) && (!filter.event || row.event === filter.event) &&
    (!filter.query || [row.about, row.name, row.eventLabel].some(value => value.toLowerCase().includes(filter.query.toLowerCase()))))
  const contacts = new Map(data.contacts.map(row => [row.id, row]))
  const visible = invited ? [...new Map(entries.slice().reverse().filter(row => row.contactId).map(row => [row.contactId, row])).values()].reverse() : entries
  return shell(chrome, title, `${workspaceNav}<h1 class="hq">${title}</h1><p class="lead">${invited ? 'People who opted in to hear about your future gatherings.' : 'People you met through your swap QR links.'}</p>
  <div class="card meet-panel"><form class="meet-filters" action="${action}">
  ${field('q', 'Name or interest', { value: filter.query, length: 100 })}
  <label class="swap-field meet-choice">Event<select name="e"><option value="">All events</option>${eventOptions.map(([id, label]) => `<option value="${h(id)}"${filter.event === id ? ' selected' : ''}>${h(label)}</option>`).join('')}</select></label>
  ${button('Filter')}</form>
  ${visible.length ? `<ul class="meet-list">${visible.slice(0, 100).map(row => {
    const name = row.name || contacts.get(row.contactId)?.name || 'Unnamed contact'
    const href = row.contactId ? '/swaps/person/' + row.contactId : '/swaps/encounter/' + row.id
    return `<li><div class="meet-row"><a href="${h(href)}"><strong>${h(name)}</strong></a><time class="meet-time" datetime="${new Date(row.at).toISOString()}">${date(row.at)}</time></div>
    <p class="small">${h(row.eventLabel)} · ${h(displayPhone(row.channels.phone) || row.channels.email || row.channels.instagram || row.channels.x || row.channels.linkedin)}${row.action === 'conflict' ? ' · Needs review' : ''}</p>
    ${row.about ? `<p>${h(row.about)}</p>` : ''}</li>`
  }).join('')}</ul>` : '<p>No swaps match this view yet.</p>'}
  ${visible.length > 100 ? '<p class="small">Showing the latest 100 matches. Filter by event or interest to narrow the list.</p>' : ''}</div>`)
}

const channelLinks = (channels, owner, event, ua, name) => {
  const body = `Hey${name ? ' ' + name.split(' ')[0] : ''}, it’s ${owner.split(' ')[0]}${event ? ' from ' + event : ''}! Great meeting you.`
  const sms = channels.phone && `sms:${channels.phone}${/iPhone|iPad|iPod/i.test(ua) ? '&' : '?'}body=${encodeURIComponent(body)}`
  return `<div class="meet-links">${sms ? safeLink(sms, 'Text back', '') : ''}
  ${channels.instagram ? external('https://ig.me/m/' + channels.instagram, 'Instagram DM') : ''}
  ${channels.x ? external('https://x.com/' + channels.x, 'Open @' + channels.x + ' on X') : ''}
  ${channels.linkedin ? external('https://www.linkedin.com/in/' + channels.linkedin + '/', 'LinkedIn') : ''}
  ${channels.email ? safeLink('mailto:' + channels.email, channels.email) : ''}</div>`
}
const labels = { open: 'Open', fulfilled: 'Helped', stale: 'Stale', withdrawn: 'Withdrawn' }
function askRows(asks, csrf, data, back) {
  return `<ul class="meet-list">${asks.map(ask => {
    const helpers = data ? suggestAskHelpers(ask, data) : []
    const contact = data?.contacts.find(row => row.authorId === ask.partyId)
    return `<li><div class="meet-row"><strong>${contact ? `<a href="/swaps/person/${h(contact.id)}">${h(ask.person)}</a>` : h(ask.person)}</strong>
    <span class="meet-time">${h(ask.source)}${ask.date ? ' · ' + h(ask.date) : ''}</span></div><p>${h(ask.text)}</p>
    ${helpers.length ? `<p class="small">Possible help: ${helpers.map(row => `<a href="/swaps/person/${h(row.id)}">${h(row.name)}</a> (${h(row.words.join(', '))})`).join(' · ')}</p>` : ''}
    ${ask.status === 'withdrawn' ? '<span class="meet-tag">Withdrawn</span>' : `<form class="meet-ask-state" method="post" action="/network/asks/status">${hidden('csrf', csrf)}${hidden('ask', ask.id)}${hidden('back', back)}
    <select name="status" aria-label="Ask status">${['open', 'stale', 'fulfilled'].map(key => `<option value="${key}"${key === ask.status ? ' selected' : ''}>${labels[key]}</option>`).join('')}</select><button class="button sm sec">Update</button></form>`}</li>`
  }).join('')}</ul>`
}

export function renderPersonAskMount(contextToken) {
  const href = '/network/asks/person?' + new URLSearchParams({ context: contextToken })
  return `<details class="card meet-panel" data-meet-asks="${h(href)}"><summary>Asks <span class="meet-optional">· private</span></summary>
  <div data-meet-asks-content><p><a href="${h(href)}">Open private asks</a></p></div></details>`
}

export function renderPersonAskPage(chrome, context, back, section) {
  return shell(chrome, 'Asks for ' + context.name, `${workspaceNav}<p><a href="${h(back)}">← Back to ${h(context.name)}</a></p>${section}`)
}

export function renderPersonAsks({ result, csrf, back }) {
  return style + `<section class="card meet-panel" aria-label="Private asks"><h2>Asks</h2>
  ${result ? (result.asks.length ? askRows(result.asks, csrf, null, back) : '<p class="small">No asks saved for this person yet.</p>') : '<p class="small">OpenChat asks are temporarily unavailable.</p>'}
  ${result?.truncated ? '<p class="small">Showing up to 100 asks.</p>' : ''}</section>`
}

export function renderSwapPerson(chrome, { contact, encounters, askResult, notice, error, ua }) {
  const latest = encounters[0]
  const name = contact ? personName(contact) : latest.name || 'Unmatched swap'
  const pending = contact ? encounters.filter(row => row.ask && !row.askId) : []
  const back = contact ? `/swaps/person/${contact.id}` : `/swaps/encounter/${latest.id}`
  return shell(chrome, name, `${workspaceNav}<div class="card meet-panel"><p class="meet-kicker">Private contact · QR swap</p>
  <h1 class="hq">${h(name)}</h1><p>${h(latest.eventLabel)} · <time datetime="${new Date(latest.at).toISOString()}">${date(latest.at)}</time> <span class="meet-tag">Unverified</span></p>
  ${errorBox(error)}${status(notice)}
  ${channelLinks(contact?.channels ?? latest.channels, chrome.displayName || 'your host', latest.eventLabel, ua, latest.name || contact?.name)}
  ${(contact?.channels.phone ?? latest.channels.phone) ? `<p class="small">${h(displayPhone(contact?.channels.phone ?? latest.channels.phone))} · Text back opens your Messages composer.</p>` : ''}
  </div>${contact ? renderPersonAsks({ result: askResult, csrf: chrome.csrf, back }) : '<p class="meet-error">This swap overlaps with existing details and was kept separate for review.</p>'}
  ${pending.length ? `<section class="card meet-panel"><h2>Asks waiting to sync</h2><ul class="meet-list">${pending.map(row => `<li><p>${h(row.ask)}</p>
  <form method="post" action="${back}">${hidden('csrf', chrome.csrf)}${hidden('action', 'retry')}${hidden('encounter', row.id)}<button class="button sec">Save to OpenChat</button></form></li>`).join('')}</ul></section>` : ''}
  ${contact ? `<section class="card meet-panel"><h2>Private note</h2><form class="meet-form" method="post" action="${back}">
  ${hidden('csrf', chrome.csrf)}${hidden('action', 'note')}${field('note', 'Quick note', { value: contact.note, length: 240, attr: 'data-voice-target' })}
  <div class="meet-links"><button class="button sec" type="button" data-meet-voice hidden>${mic} Dictate note</button>${button('Save note')}</div><p class="small" data-voice-status aria-live="polite"></p>
  </form></section>` : ''}
  <section class="card meet-panel"><h2>Encounters</h2><ul class="meet-list">${encounters.map(row => `<li><div class="meet-row"><strong>${h(row.eventLabel)}</strong><time class="meet-time" datetime="${new Date(row.at).toISOString()}">${date(row.at)}</time></div>
  ${row.about ? `<p>${h(row.about)}</p>` : ''}${row.ask && !row.askId && !contact ? `<p>Ask: ${h(row.ask)}</p>` : ''}
  ${row.invite ? '<span class="meet-tag">Invite opt-in</span> ' : ''}${row.group ? '<span class="meet-tag">Group interest</span>' : ''}</li>`).join('')}</ul></section>`)
}

export function renderNetworkAsks(chrome, { result, data, error, notice, draft, candidates, proof }) {
  const groups = new Map()
  for (const ask of result?.asks ?? []) {
    const theme = askTheme(ask.text)
    if (!groups.has(theme)) groups.set(theme, [])
    groups.get(theme).push(ask)
  }
  const confirm = draft && candidates?.length ? `<div class="card meet-panel"><h2>Confirm the ask</h2>
    <form class="meet-form" method="post" action="/network/asks/save">${hidden('csrf', chrome.csrf)}${hidden('proof', proof)}
    ${candidates.length > 1 ? `<fieldset><legend>Which ${h(draft.name)}?</legend>${candidates.map((person, i) => `<label class="swap-check"><input type="radio" name="person" value="${i}" required><span>${h(person.name)} · ${h(person.detail)}</span></label>`).join('')}</fieldset>` : `${hidden('person', '0')}<p><strong>${h(candidates[0].name)}</strong></p>`}
    <p>${h(draft.text)}</p><div class="meet-links">${button('Save private ask')} <a href="/network/asks">Cancel</a></div></form></div>` : ''
  return shell(chrome, 'Your network’s asks', `${workspaceNav}<h1 class="hq">Your network’s asks</h1><p class="lead">What people you know could use help with. Only you can see this list.</p>
  ${errorBox(error)}${status(notice)}${confirm}
  ${!draft && !result ? '<p>OpenChat asks could not be loaded. Please try again shortly.</p>' : ''}
  ${!draft && result && !groups.size ? '<div class="card meet-panel"><h2>No open asks yet</h2><p>Use Capture ask, or share a swap QR to learn what someone needs.</p></div>' : ''}
  ${[...groups].map(([theme, asks]) => `<section class="card meet-panel"><h2>${h(theme)}</h2>${askRows(asks, chrome.csrf, data, '/network/asks')}</section>`).join('')}
  ${result?.truncated ? '<p class="small">Showing the first 100 open or stale asks.</p>' : ''}`)
}

export function meetAgent({ csrf, contextToken, context, value = '' }) {
  return style + `<details class="meet-agent"${value ? ' open' : ''}><summary class="button">${mic}<span class="meet-agent-label">Capture ask</span></summary>
  <aside class="card meet-panel"><form class="meet-form" method="post" action="/network/asks/preview">${hidden('csrf', csrf)}
  ${contextToken ? hidden('context', contextToken) : ''}${hidden('source', 'Typed')}
  ${field('text', context ? 'Ask for ' + context.name : 'Capture a private ask', { length: 240, value, placeholder: context ? 'Needs an intro to…' : 'Maya needs a cofounder', attr: 'required data-voice-target' })}
  <div class="meet-links"><button class="button sec" type="button" data-meet-voice hidden>${mic} Dictate</button>${button('Review ask')}<a href="/network/asks">All asks</a> <a href="/swaps">Swaps</a></div>
  <p class="small" data-voice-status aria-live="polite"></p></form></aside></details>`
}

// On-device recognition only. System keyboard dictation and typing also work
// in browsers without local SpeechRecognition or an installed language pack.
export const MEET_VOICE_SCRIPT = `;(() => {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition
  const local = window.isSecureContext && Speech && 'processLocally' in Speech.prototype
  for (const button of document.querySelectorAll('[data-meet-voice]')) {
    const input = button.form?.querySelector('[data-voice-target]')
    const status = button.form?.querySelector('[data-voice-status]')
    if (!input || !status) continue
    if (!local) { status.textContent = 'Type or use your keyboard’s dictation.'; continue }
    button.hidden = false
    button.addEventListener('click', () => {
      const recognition = new Speech()
      recognition.lang = navigator.language
      recognition.processLocally = true
      recognition.onstart = () => { button.disabled = true; status.textContent = 'Listening on this device…' }
      recognition.onend = () => { button.disabled = false; if (status.textContent.startsWith('Listening')) status.textContent = '' }
      recognition.onerror = () => { button.disabled = false; status.textContent = 'Local dictation is unavailable. Type or use your keyboard’s dictation.' }
      recognition.onresult = event => {
        input.value = event.results[0][0].transcript.slice(0, input.maxLength)
        const source = button.form.elements.namedItem('source')
        if (source) source.value = 'Dictated'
        status.textContent = 'Review the text before saving.'
        input.focus()
      }
      try { recognition.start() } catch { recognition.onerror() }
    })
  }
  for (const section of document.querySelectorAll('[data-meet-asks]')) {
    section.addEventListener('toggle', async () => {
      if (!section.open || section.dataset.loaded) return
      section.dataset.loaded = 'pending'
      try {
        const response = await fetch(section.dataset.meetAsks, { headers: { Accept: 'text/html; fragment=asks' } })
        if (!response.ok) throw new Error('asks unavailable')
        section.querySelector('[data-meet-asks-content]').innerHTML = await response.text()
        section.dataset.loaded = 'yes'
      } catch { delete section.dataset.loaded }
    })
  }
  if (document.querySelector('[data-meet-asks]')) window.addEventListener('pageshow', event => { if (event.persisted) location.reload() })
})();`
