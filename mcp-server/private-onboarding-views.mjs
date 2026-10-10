import { publicLinkedinUrl, publicWebsite } from '../src/utils/public-people/profile-links.mjs'
import { parseAccountScope, scopeAllowsConnectionActions, scopeAllowsPrivateNotes } from './account-grants.mjs'
import { readFileSync } from 'node:fs'
import { OMNI_SEARCH_SCRIPT } from './omni-search.mjs'
import { profileDetailLevel, companyDetailLevel } from '../src/utils/public-people/detail-level.mjs'
import { ONBOARDING_STYLE } from './private-onboarding-style.mjs'
import { displayPhone, whatsappUrl, isSafeContactLink } from './contact-card.mjs'
import { PHOTO_URL } from './profile-photos.mjs'
import { unlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'

const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const raw = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const html = value => raw(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const list = value => Array.isArray(value) ? value : []
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'
const csrfInput = csrf => `<input type="hidden" name="csrf" value="${html(csrf)}">`
const openChatAction = profileUrl => `<a class="button sec sm" href="${html(profileUrl ? `/messages?profile=${encodeURIComponent(profileUrl)}` : '/messages')}">Message</a>`
const openChatNote = () => ''
const LINKEDIN_EXPORT = 'https://www.linkedin.com/mypreferences/d/download-my-data'
const exportHelp = () => `<div class="export-help"><p class="small"><a data-linkedin-export href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Don't have your LinkedIn export yet? Request it now ↗</a></p><p class="small">The complete archive (recommended) is usually ready in about a day; Connections can take up to 48 hours. Sign up while you wait. Download your file within 3 days of LinkedIn’s email, then upload it here.</p></div>`
// Browser-only progress: opening LinkedIn is remembered, never asserted as a
// submitted export request, account identity or an email/reminder timestamp.
export const LINKEDIN_EXPORT_PROGRESS_SCRIPT = `(()=>{
  const links=[...document.querySelectorAll('[data-linkedin-export]')];if(!links.length)return;
  const key='unlinked.linkedin-export-opened.v1',ttl=4*24*60*60*1000;
  let memoryAt=0;
  const valid=at=>Number.isFinite(at)&&at>0&&at<=Date.now()&&Date.now()-at<ttl;
  const read=()=>{try{const at=Number(localStorage.getItem(key));if(valid(at))return true;if(at)localStorage.removeItem(key)}catch{}return valid(memoryAt)};
  const labels=new Map(links.map(link=>[link,link.textContent]));
  const draw=opened=>{for(const link of links){link.classList.toggle('export-opened',opened);link.textContent=opened?'Export page opened ✓':labels.get(link);link.closest('li')?.classList.toggle('export-opened-step',opened)}const status=document.getElementById('linkedin-export-status');if(status){status.hidden=!opened;status.textContent=opened?'If you requested your archive, check your inbox for LinkedIn’s email. You can create your profile while you wait.':''}};
  for(const link of links)link.addEventListener('click',event=>{if(event.defaultPrevented||(event.button!==undefined&&event.button!==0))return;memoryAt=Date.now();try{localStorage.setItem(key,String(memoryAt))}catch{}draw(true)});
  addEventListener('pageshow',()=>draw(read()));
  addEventListener('storage',event=>{if(event.key===key||event.key===null){memoryAt=0;draw(read())}});
  draw(read());
})();`;

const exportSteps = () => '<ol><li>Open LinkedIn’s data download settings on a personal computer.</li><li>Choose “Download larger data archive” (recommended) for your full profile and connections, or select Connections.</li><li>Download your file within 3 days (72 hours) of LinkedIn’s email, then upload it here. Once downloaded, your saved file does not expire.</li></ol>'
// Keep native POSTs and their CSRF tokens on the current host.
const localAction = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\s\x00-\x1f\x7f#]/.test(value) ? value : null
const profileLookup = ({ linkedinLookup, lookupResult, csrf, address = '' }) => {
  const action = localAction(linkedinLookup?.action)
  const claimAction = lookupResult?.status === 'found' ? localAction(lookupResult.claimAction) : null
  return `${action ? `<form class="linkedin-lookup" method="post" action="${html(action)}">${csrfInput(csrf)}<label for="onboarding-linkedin-url">Find yourself on Unlinked <span class="small">Your LinkedIn address</span></label><input id="onboarding-linkedin-url" type="text" name="linkedinUrl" maxlength="2048" value="${html(address)}" placeholder="linkedin.com/in/your-name" autocomplete="url" autocapitalize="off" spellcheck="false"><p class="small">Checks saved Unlinked profiles, then tries your public LinkedIn page when lookup is available. Nothing is claimed until you confirm.</p><button class="quiet" type="submit">Find me</button></form>` : ''}${claimAction ? `<div class="panel lookup-result"><h2>Is this you?</h2>${lookupResult.test === true ? '<p class="notice test-profile" role="note"><b>Test profile.</b> Not a real person and never shown publicly. An operator can release the claim afterwards.</p>' : ''}${lookupResult.source === 'profile-lookup' ? `${avatar(lookupResult.profileName)}<p class="small">from your public LinkedIn profile</p>` : ''}<h3>${lookupResult.id && lookupResult.test !== true ? `<a href="${html(`/people/${encodeURIComponent(lookupResult.id)}`)}" target="_blank" rel="noopener">${html(lookupResult.profileName)}</a> <a class="small" href="${html(`/people/${encodeURIComponent(lookupResult.id)}`)}" target="_blank" rel="noopener">View profile ↗</a>` : html(lookupResult.profileName)}</h3><p>${html(lookupResult.headline)}</p>${lookupResult.location ? `<p class="small">${html(lookupResult.location)}</p>` : ''}${lookupResult.source === 'profile-lookup' ? `${experience(lookupResult.positions, 'Your export can add more experience.')}${education(lookupResult.education)}` : ''}${lookupResult.listedBy > 0 ? `<p>Listed by ${count(lookupResult.listedBy)} ${lookupResult.listedBy === 1 ? 'member' : 'members'}</p>` : ''}<form method="post" action="${html(claimAction)}">${csrfInput(csrf)}${lookupResult.claimToken ? `<input type="hidden" name="candidate" value="${html(lookupResult.claimToken)}">` : ''}<div class="actions"><button type="submit">Yes, that's me</button><a class="quiet" href="/profile">Not me</a></div></form></div>` : ''}`
}

// Three finder squares: the universal "QR code" mark. An element, not a data: image (CSP).
const QR_ICON = '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1"/><rect x="12" y="2.5" width="5.5" height="5.5" rx="1"/><rect x="2.5" y="12" width="5.5" height="5.5" rx="1"/><path d="M12 12h2.2v2.2H12zM15.3 15.3h2.2v2.2h-2.2zM12 17.5h1M17.5 12v1" fill="currentColor"/></svg>'
// The signed-in member's single account menu ("Me"), LinkedIn-style. A native
// <details> so it opens, closes and is reachable without script; the page's
// TOP_BAR_SCRIPT adds Escape, click-away, arrow keys and aria-expanded. The
// headline is filled per request through ME_HEADLINE_SLOT (see fillMeHeadline).
export const ME_HEADLINE_SLOT = '<!--me-headline-->'
const meMenu = ({ displayName, csrf }) => {
  const name = chipLabel(displayName)
  const face = `<span class="initials avatar" aria-hidden="true">${html(initials(name)) || '·'}</span>`
  // The avatar goes straight to your profile; "Me" opens the menu.
  return `<a class="me-face" href="/profile" aria-label="Your profile" title="Your profile">${face}</a><details class="me"><summary aria-haspopup="menu" aria-label="Me: account menu${name ? ` for ${html(name)}` : ''}"><span class="me-l">Me<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></span></summary><div class="me-panel" role="menu" aria-label="Account"><div class="me-head" role="none">${face}<div class="me-who"><b>${html(name) || 'Your account'}</b>${ME_HEADLINE_SLOT}</div><a class="button sec sm me-view" role="menuitem" href="/profile">View profile</a></div><a role="menuitem" href="/card">${QR_ICON}My card</a><a role="menuitem" href="/scan">${SCAN_ICON}Scan a card</a><a role="menuitem" href="/settings">${GEAR_ICON}Settings &amp; agent setup</a><div class="me-sep" role="separator"></div><form method="post" action="/switch-account" role="none">${csrfInput(csrf)}<button type="submit" class="me-out" role="menuitem">Switch account</button></form><form method="post" action="/logout" role="none">${csrfInput(csrf)}<button type="submit" class="me-out" role="menuitem">Sign out</button></form></div></details>`
}
const SCAN_ICON = '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 6.5v-3a1 1 0 0 1 1-1h3M13.5 2.5h3a1 1 0 0 1 1 1v3M17.5 13.5v3a1 1 0 0 1-1 1h-3M6.5 17.5h-3a1 1 0 0 1-1-1v-3M5 10h10"/></svg>'
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
// The member's headline is known once their profile has been read this session;
// until then the menu shows the name alone. Always escaped.
export const fillMeHeadline = (content, headline) => content.replace(ME_HEADLINE_SLOT, raw(headline).trim() ? `<span class="me-hl">${html(raw(headline).trim())}</span>` : '')
// Progressive enhancement for the global search and Me menu. Runs under each page's script nonce.
export const TOP_BAR_SCRIPT = `(()=>{const me=document.querySelector('details.me');if(!me)return;const sum=me.querySelector('summary'),items=()=>[...me.querySelectorAll('[role=menuitem]')];let byKey=false;const sync=()=>sum.setAttribute('aria-expanded',String(me.open));sync();me.addEventListener('toggle',()=>{sync();if(me.open&&byKey)items()[0]?.focus();byKey=false});sum.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')byKey=true;else if(e.key==='ArrowDown'&&!me.open){e.preventDefault();byKey=true;me.open=true}});me.addEventListener('keydown',e=>{if(!me.open)return;const list=items(),i=list.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();me.open=false;sum.focus()}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();list[e.key==='ArrowDown'?(i+1)%list.length:(i<=0?list.length-1:i-1)]?.focus()}else if(e.key==='Home'||e.key==='End'){e.preventDefault();list[e.key==='Home'?0:list.length-1]?.focus()}else if(e.key==='Tab')me.open=false});document.addEventListener('click',e=>{if(me.open&&!me.contains(e.target))me.open=false});me.addEventListener('focusout',e=>{if(me.open&&e.relatedTarget&&!me.contains(e.relatedTarget))me.open=false})})();(()=>{const h=document.getElementById('pwa-hint');if(!h)return;const seen=()=>{try{return localStorage.getItem('pwa-hint-dismissed')}catch{return '1'}};if(matchMedia('(pointer:coarse)').matches&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone&&!seen())h.hidden=false;document.getElementById('pwa-hint-dismiss').addEventListener('click',()=>{h.hidden=true;try{localStorage.setItem('pwa-hint-dismissed','1')}catch{}})})();` + OMNI_SEARCH_SCRIPT

// One search box, in the header of every page. A plain GET, so it works before
// sign-in, can be bookmarked and needs no script.
const headerSearch = ({ query, mode, presence, sort, connected }) => `<form class="header-search" method="get" action="/network" role="search">${presence ? `<input type="hidden" name="presence" value="${html(presence)}">` : ''}${sort ? `<input type="hidden" name="sort" value="${html(sort)}">` : ''}${connected ? '<input type="hidden" name="connected" value="1">' : ''}${mode === 'exact' ? '<input type="hidden" name="mode" value="exact">' : ''}<svg class="search-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 4 4"/></svg><input name="q" type="search" enterkeyhint="search" maxlength="200" aria-label="Search everyone on Unlinked" value="${html(query)}" placeholder="Search people, roles, companies"><button type="submit" aria-label="Search"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg></button><a class="scan" href="/scan" aria-label="Scan a QR code or show your card" title="Scan a card · show yours">${QR_ICON}</a><div class="omni-panel" hidden><div id="omni-suggestions" role="listbox" aria-label="Search suggestions"></div><div class="omni-status" role="status" aria-live="polite"></div></div></form>`
const steps = active => `<div class="steps" aria-label="Getting started">${['Account', 'Your LinkedIn export', 'Your profile'].map((name, index) => `<${active === index + 1 ? 'b aria-current="step"' : 'span'}>${index + 1}. ${name}</${active === index + 1 ? 'b' : 'span'}>`).join('<span aria-hidden="true">·</span>')}</div>`
const terminalJob = job => ['indexed', 'partial', 'failed'].includes(job?.status)
// A partial import whose files all read is finished: only some rows were skipped.
const rowsSkipped = job => job?.status === 'partial' && !job.failedFiles && Number.isSafeInteger(job.rejected) && job.rejected > 0
const skippedLabel = job => `Import finished · ${count(job.total)} people · ${count(job.rejected)} ${job.rejected === 1 ? 'row' : 'rows'} skipped`
const jobLabel = job => job?.status === 'indexed' ? 'Import finished' : rowsSkipped(job) ? skippedLabel(job) : job?.status === 'partial' ? 'Import needs attention' : job?.status === 'failed' ? 'Import could not finish' : 'Importing…'
const jobProgress = job => Number.isSafeInteger(job?.total) && job.total > 0 && Number.isSafeInteger(job.processed) && job.processed >= 0 && job.processed <= job.total
  ? { processed: job.processed, total: job.total, percent: Math.round(job.processed / job.total * 100) } : null
const knownJob = job => job && ['uploaded', 'parsing', 'indexing', 'indexed', 'partial', 'failed'].includes(job.status)
const progress = job => { const value = jobProgress(job); return `<progress aria-label="Import in progress"${value ? ` value="${value.processed}" max="${value.total}"` : ''}></progress>` }
const jobStatus = job => {
  if (!knownJob(job)) return ''
  const finished = terminalJob(job)
  const value = jobProgress(job)
  const label = job.status === 'indexed' ? `Import finished · ${count(job.total)} records` : !finished && value ? `Importing · ${value.percent}% · ${count(value.processed)} of ${count(value.total)} records` : jobLabel(job)
  return `<aside class="import-status" role="status" aria-live="polite"><strong>${label}</strong>${!finished ? `${progress(job)}<p>Keeps running even if you leave this page.</p>${job.profileReady ? '<p>Your profile is ready; connections are still coming in.</p>' : ''}` : ''}${job.status === 'partial' ? `<p><a href="/settings">${rowsSkipped(job) ? 'Details' : 'Review in Settings'}</a></p>` : ''}${job.errorMessage ? `<p>${html(job.errorMessage)}</p>` : ''}</aside>`
}
const jobPill = job => { if (!knownJob(job) || terminalJob(job)) return ''; const value = jobProgress(job); return `<a class="pill" href="/profile" title="Importing keeps running even if you leave">${value ? `Importing · ${value.percent}%` : 'Importing…'}</a>` }
const footer = ({ csrf, accountLabel }) => `<footer><span>unlinked · an open professional network · <span class="app-version">v${html(APP_VERSION)}</span></span><span><a href="https://www.unlinked.ai/meet" target="_blank" rel="noopener noreferrer">Meet someone in person ↗</a><a href="https://worldissuetracker.com/tracker/unlinked-ai" target="_blank" rel="noopener noreferrer">Feedback ↗</a><a href="/agents">For agents</a><a href="/llms.txt">llms.txt</a></span><span>Not affiliated with LinkedIn.</span>${csrf ? `<span class="account">${accountLabel ? `Signed in as ${html(accountLabel)} · ` : ''}<form class="sign-out" method="post" action="/logout">${csrfInput(csrf)}<button class="link-button">Sign out</button></form></span>` : ''}</footer>`
// My Network and the notification bell. The runtime fills the slot per request
// (fillNavAlerts) with live counts, and only when those features are configured;
// an unfilled slot is an empty comment.
export const NAV_ALERTS_SLOT = '<!--nav-alerts-->'
const NETWORK_NAV_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14c2.4.1 4 1.5 4.5 4.2"/></svg>'
const BELL_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>'
const badgeCount = value => value > 99 ? '99+' : String(value)
const navIcon = (href, label, icon, value, noun) => {
  const counted = Number.isSafeInteger(value) && value > 0
  return `<a class="nav-ico" href="${href}" title="${label}" aria-label="${label}${counted ? `, ${badgeCount(value)} ${noun}` : ''}">${icon}${counted ? `<span class="badge" aria-hidden="true">${badgeCount(value)}</span>` : ''}</a>`
}
// alerts: { network?: pending received requests, notifications?: unseen count }.
// A missing key means that feature is off, so its icon is not shown.
export function navAlerts(alerts) {
  if (!alerts) return ''
  return `${alerts.network !== undefined ? navIcon('/invitations', 'My Network', NETWORK_NAV_ICON, alerts.network, 'pending') : ''}${alerts.notifications !== undefined ? navIcon('/notifications', 'Notifications', BELL_ICON, alerts.notifications, 'new') : ''}`
}
export const fillNavAlerts = (content, alerts) => content.replace(NAV_ALERTS_SLOT, navAlerts(alerts))
// The account chip shows a name, never a full address or an opaque identifier.
const chipLabel = value => { const text = raw(value).trim(); return !text || /^[0-9a-f-]{20,}$/i.test(text) ? '' : text.includes('@') ? text.split('@')[0] : text }
// Signed out, the header has one sign-in control (Ideaflow ID also handles
// sign-up), omitted on pages whose body is the "Sign in with Ideaflow" button.
const base = (title, content, { accountLabel, displayName, csrf, importJob, query = '', mode, presence, sort, connected, network = false, signInInBody = false } = {}) => ({ title, content: `<style>${ONBOARDING_STYLE}${HUES.map((color, index) => `.tone-${index}{--h:${color}}.unlinked-onboarding .avatar.tone-${index},.unlinked-onboarding .faces .tone-${index}{background:${color}}`).join('')}.mini-caption{margin:14px 24px 0}.connection-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.person>div{min-width:0}.person .connection-actions{margin-top:10px}.connection-remove{font-size:13px}.connection-remove summary{cursor:pointer}.connection-remove p{max-width:32ch}</style><div class="unlinked-onboarding"><header><a class="logo" href="https://www.unlinked.ai/" aria-label="Unlinked home"><strong>unlinked</strong></a>${network ? `<a class="scan" href="/scan" aria-label="Scan a QR code or show your card">${QR_ICON}</a>` : headerSearch({ query, mode, presence, sort, connected })}<nav aria-label="Main navigation">${csrf ? `${jobPill(importJob)}<a class="my-card-link" href="/card">${QR_ICON}My card</a><a href="/network">People</a><a href="/messages">Messages</a><a class="hide-m" href="/agents">For agents</a>${NAV_ALERTS_SLOT}${meMenu({ displayName, csrf })}` : `<a href="/people">Explore</a><a class="hide-m" href="/agents">For agents</a>${signInInBody ? '' : '<a class="button sm" href="/login">Sign in</a>'}`}</nav></header>${jobStatus(importJob)}<main class="journey">${content}</main>${footer({ csrf, accountLabel })}</div>` })

const HUES = ['#4349c4', '#2f6f8f', '#8a5a2b', '#6b4fa0', '#b0413e', '#3d6f7a']
const hue = seed => { let hash = 0; for (const character of raw(seed)) hash = (hash * 31 + character.codePointAt(0)) >>> 0; return HUES[hash % HUES.length] }
const initials = name => raw(name).trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? '').join('')
// A given name reads well as a possessive; an initial such as “A.” does not.
const firstName = name => { const first = raw(name).trim().split(/\s+/)[0] ?? ''; return [...first].length > 2 && !first.endsWith('.') ? first : '' }
// A published profile photo (same-origin only, so it passes the page CSP),
// else the initials. `photo` is accepted only in the exact photo route grammar.
const photoSrc = value => typeof value === 'string' && PHOTO_URL.test(value) ? value : null
const photoImg = (className, photo, name, size) => `<img class="${className}" src="${html(photo)}" alt="${html(raw(name).trim())}" width="${size}" height="${size}" loading="lazy" decoding="async">`
const avatar = (name, seed = name, photo) => photoSrc(photo) ? photoImg(`avatar photo tone-${HUES.indexOf(hue(seed))}`, photo, name, 44) : `<span class="initials avatar tone-${HUES.indexOf(hue(seed))}" aria-hidden="true">${html(initials(name))}</span>`
// The large profile-header face.
const profileFace = (profile, toneClass = '') => photoSrc(profile.photo) ? photoImg(`pav photo${toneClass}`, profile.photo, profile.name, 96) : `<div class="pav${toneClass}">${html(initials(profile.name)) || '·'}</div>`
const externalProfile = value => { try { const url = new URL(value); return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) && !url.username && !url.password ? url.href : null } catch { return null } }
const profileLinks = profile => {
  const linkedin = publicLinkedinUrl(profile.linkedinUrl), website = publicWebsite(profile.website)
  const links = [linkedin ? `<a href="${html(linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a>` : '', website ? `<a href="${html(website)}" target="_blank" rel="noopener noreferrer nofollow">Website ↗</a>` : ''].filter(Boolean)
  return links.length ? `<p class="small profile-links">${links.join(' · ')}</p>` : ''
}
const PRESENCE_FILTERS = [[undefined, 'All'], ['member', 'On Unlinked'], ['shadow', 'Not yet on Unlinked']]
const subline = value => [raw(value.headline), raw(value.company)].filter(Boolean).join(' · ')
// Imported people who have not joined. A network icon marks those connected to
// more than one person here, so their page leads somewhere; a dot marks a stub.
const NETWORK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="3.5" cy="8" r="2"/><circle cx="12.5" cy="3.5" r="2"/><circle cx="12.5" cy="12.5" r="2"/><path d="M5.3 7.1 10.7 4.4M5.3 8.9l5.4 2.7"/></svg>'
const STUB_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>'
const reach = value => Number.isSafeInteger(value?.connectionCount) && value.connectionCount > 1
const shadowBadge = (value, { withCount = true } = {}) => value?.presence !== 'shadow' ? (value?.presence === 'member' ? '<span class="membership-member">On Unlinked</span>' : '') : reach(value)
  ? `<span class="shadow net" title="Not on Unlinked yet. Imported profile connected to ${html(count(value.connectionCount))} people here.">${NETWORK_ICON}Not on Unlinked${withCount ? ` · ${html(count(value.connectionCount))}` : ''}</span>`
  : `<span class="shadow" title="Not on Unlinked yet. Imported profile known through one connection.">${STUB_ICON}Not on Unlinked</span>`
const BASIC_PAGE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 9h4"/></svg>'
const basicMarker = label => `<span class="basic-marker" title="${html(label)}">${BASIC_PAGE_ICON}<span class="sr-only"> ${html(label)}</span></span>`
const detailMarker = value => value.detailLevel === 'basic' ? basicMarker('Basic profile — additional details not listed yet') : ''
const contactHref = value => /^\/network\/contacts\/[A-Za-z0-9._~%-]{1,480}$/.test(raw(value.contactHref)) ? html(value.contactHref) : null
const personName = value => value.id ? `<a href="${memberHref(value)}">${html(value.name) || 'Unnamed connection'}${detailMarker(value)}</a>` : contactHref(value) ? `<a href="${contactHref(value)}">${html(value.name) || 'Unnamed connection'}</a>` : html(value.name) || 'Unnamed connection'
// The signed-in owner's private context mount: an empty, hidden element the
// page script fills from the owner-only endpoint. No private data in the HTML.
const privateContextMount = (url, name) => `<div class="card sec private-context" data-private-context="${html(url)}" data-name="${html(raw(name).trim())}" aria-live="polite" hidden></div>`
// One person drawn from several of the owner's records (unlinked-tto.4): a
// quiet disclosure lists each record and where it came from.
const isoDay = at => Number.isSafeInteger(at) && at > 0 && at <= 8640000000000000 ? new Date(at).toISOString().slice(0, 10) : null
const sourceItem = source => {
  const day = isoDay(source.connectedAt ?? source.importedAt), when = day ? ` · ${source.connectedAt ? 'connected' : 'imported'} <time datetime="${day}">${day}</time>` : ''
  const label = contactHref(source) ? `<a href="${contactHref(source)}">${html(source.label)}</a>` : html(source.label)
  return `<li>${label}${when}</li>`
}
const sourcesDisclosure = value => Array.isArray(value.sources) && value.sources.length > 1 ? `<details class="sources"><summary>${count(value.sources.length)} sources</summary><ul>${value.sources.map(source => sourceItem({ ...source, contactHref: source.href })).join('')}</ul></details>` : ''
const person = value => `<article class="person">${avatar(value.name, value.id ?? value.name, value.photo)}<div><h3>${personName(value)}${shadowBadge(value)}</h3><p>${html(subline(value))}</p>${externalProfile(value.linkedinUrl) ? `<a class="small" href="${html(externalProfile(value.linkedinUrl))}" target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a>` : ''}${sourcesDisclosure(value)}</div></article>`
const memberHref = value => html(`/people/${encodeURIComponent(raw(value.id))}`)
const member = value => `<article class="person">${avatar(value.name, value.id, value.photo)}<div><h3><a href="${memberHref(value)}">${html(value.name)}${detailMarker(value)}</a>${shadowBadge(value)}</h3>${value.headline || value.company ? `<p>${html(subline(value))}</p>` : ''}${value.location ? `<p class="small">${html(value.location)}</p>` : ''}</div></article>`
const connectionRow = value => value.id
  ? `<a class="crow" href="${memberHref(value)}">${avatar(value.name, value.id, value.photo)}<span><strong>${html(value.name)}</strong>${shadowBadge(value)}${detailMarker(value)}${subline(value) ? `<br><span class="small">${html(subline(value))}</span>` : ''}</span></a>`
  : `<div class="crow">${avatar(value.name)}<span><strong>${html(value.name) || 'Unnamed connection'}</strong>${subline(value) ? `<br><span class="small">${html(subline(value))}</span>` : ''}</span></div>`
const dates = value => [raw(value.startDate), raw(value.endDate)].filter(Boolean).join(' to ')
const companyLink = (value, detailLevel) => raw(value).trim() ? `<a href="${html(`/companies/${encodeURIComponent(raw(value).trim())}`)}">${html(value)}${detailLevel === 'basic' ? basicMarker('Basic company page — company details not listed yet') : ''}</a>` : ''
const experience = (positions, empty) => `<div class="card sec"><h3>Experience</h3>${list(positions).length ? list(positions).map(value => `<div class="xp"><b>${html(value.title)}</b>${companyLink(value.company, value.companyDetailLevel)}${dates(value) ? `<br><span class="small">${html(dates(value))}</span>` : ''}${value.description ? `<p>${html(value.description)}</p>` : ''}</div>`).join('') : `<p class="small">${empty}</p>`}</div>`
const education = schools => list(schools).length ? `<div class="card sec"><h3>Education</h3>${list(schools).map(value => `<div class="xp"><b>${html(value.institution)}</b>${value.degree ? `<br>${html(value.degree)}` : ''}${dates(value) ? `<br><span class="small">${html(dates(value))}</span>` : ''}</div>`).join('')}</div>` : ''
const skills = values => list(values).length ? `<div class="card sec"><h3>Skills</h3><div class="tags">${list(values).map(value => `<span class="tag">${html(value)}</span>`).join('')}</div></div>` : ''
const sampleProfile = () => `<div class="card phead mini" aria-hidden="true"><div class="banner"></div><div class="pav">AL</div><h1>Avery Lee</h1><p class="hl">Director of Partnerships, Northwind Solar</p><span class="small">Oakland, California · 312 connections</span><div class="mini-sec"><b>Experience</b><p>Director of Partnerships · Northwind Solar<br><span class="small">2019 to now</span></p><p>Programme Manager · Open Orchard<br><span class="small">2015 to 2019</span></p></div><div class="mini-sec"><b>Connections</b><div class="faces"><span class="tone-1">MS</span><span class="tone-3">PB</span><span class="tone-2">KN</span><span class="tone-4">ZH</span><span class="moref">+308</span></div></div><p class="small mini-caption">Illustration with a fictional person.</p></div>`

// Other apps' built-in browsers keep their own cookies, so LinkedIn is signed out there
// (and Google sign-in is refused). Detection misses some (iOS Gmail/Slack look like Safari),
// so step 1 always carries a plain hint too.
const IN_APP_BROWSERS = [[/Instagram/, 'Instagram'], [/Barcelona/, 'Threads'], [/FBAN|FBAV|FB_IAB|FBIOS/, 'Facebook'], [/LinkedInApp/, 'LinkedIn'], [/GSA\//, 'Google'], [/Bytedance|musical_ly|TikTok/i, 'TikTok'], [/Snapchat/, 'Snapchat'], [/Line\//, 'LINE'], [/Twitter|TwitterAndroid/, 'X']]
export function inAppBrowser(userAgent) {
  const value = typeof userAgent === 'string' ? userAgent.slice(0, 1024) : ''
  const android = /Android/.test(value)
  const match = IN_APP_BROWSERS.find(([pattern]) => pattern.test(value))
  if (match) return { app: match[1], browser: android ? 'Chrome' : 'Safari', os: android ? 'android' : 'ios' }
  if (android && /; wv\)/.test(value)) return { app: 'this app', browser: 'Chrome', os: 'android' }
  return null
}
// A link that asks the host app to hand an https URL to the system browser. These only
// work on a tap (apps drop scripted redirects), and some apps refuse them, so the page
// always keeps the manual instruction. Returns null where no known escape exists.
export function escapeHref(target, inApp) {
  if (!inApp) return null
  const url = new URL(target)
  if (url.protocol !== 'https:') return null
  const rest = `${url.host}${url.pathname}${url.search}`
  if (inApp.os === 'android') return `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`
  if (inApp.app === 'Instagram') return `instagram://extbrowser/?url=${encodeURIComponent(url.href)}`
  if (inApp.app === 'Threads') return `barcelona://extbrowser/?url=${encodeURIComponent(url.href)}`
  if (inApp.app === 'TikTok') return null
  return `x-safari-https://${rest}`
}

export function renderLanding({ inApp = null } = {}) {
  const escapeExport = escapeHref(LINKEDIN_EXPORT, inApp), escapeHome = escapeHref('https://www.unlinked.ai/', inApp)
  const banner = inApp ? `<div class="notice in-app" role="note"><p>You’re in ${html(inApp.app)}’s browser, which isn’t signed in to LinkedIn. Unlinked works best in ${html(inApp.browser)}.</p>${escapeHome ? `<a class="button sec brand" href="${html(escapeHome)}">Open Unlinked in ${html(inApp.browser)}</a>` : ''}<p class="small">Didn’t open? Tap ••• and choose <b>Open in ${html(inApp.browser)}</b>.</p></div>` : ''
  return base('Your professional profile and network', `${banner}<section class="land"><div><h1>Your professional profile and network, in a place that’s yours.</h1><p class="lead">Bring your profile and connections from LinkedIn. Explore who knows whom. Ask your AI agent who you need.</p><ol class="land-steps" aria-label="How to join"><li><span class="n">1</span><div><b>Ask LinkedIn for your file</b><p class="small">Choose the <b>complete archive (recommended)</b> for your profile and connections. Usually ready in about a day; some data can take up to 48 hours. Download within 3 days of LinkedIn’s email.</p>${escapeExport ? `<a class="button lg" data-linkedin-export aria-describedby="linkedin-export-status" href="${html(escapeExport)}">Start my LinkedIn export ↗</a>` : `<a class="button lg" data-linkedin-export aria-describedby="linkedin-export-status" href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Start my LinkedIn export ↗</a>`}<p id="linkedin-export-status" class="small land-hint" role="status" aria-live="polite" hidden></p><p class="small land-hint">On a phone? It works in Safari or Chrome, not in the LinkedIn app.</p></div></li><li><span class="n">2</span><div><b>Create your profile while you wait</b><p class="small">Paste your LinkedIn address and we’ll find you.</p><a class="button lg" href="/join">Create my profile</a></div></li><li class="later"><span class="n">3</span><div><b>Upload the file when it arrives</b><p class="small">Your connections become searchable here and from Claude. Already have it? <a href="/join">Bring my file</a></p></div></li></ol><p class="land-explore"><a href="/people">or explore profiles first →</a></p></div><div>${sampleProfile()}</div></section><section class="agent-demo"><div><p class="eyebrow">Built for AI agents too</p><h2>Ask Claude about your own network.</h2><p class="lead">Connect Unlinked once. Claude, ChatGPT or Cursor can then search your people and everyone on Unlinked.</p><pre>https://www.unlinked.ai/mcp</pre><a href="/agents">How agents connect and what to upload →</a></div><figure class="claude-demo" aria-label="Example Claude conversation using Unlinked"><figcaption>✳ Claude</figcaption><div class="demo-user">Find gaming investors in my network.</div><p class="demo-tool">⚙ <b>unlinked</b> · searched your connections</p><ol class="demo-answer"><li><b>Maya Chen</b>, GP at Emberfield Ventures <span>— fund focused on games</span></li><li><b>Priya Shah</b>, Partner at Alderbridge Capital <span>— leads consumer and gaming deals</span></li><li><b>Marcus Reed</b>, Investor at Cedarpath Ventures <span>— former game studio producer</span></li></ol><p class="small demo-note">Example with fictional people.</p></figure></section>`)
}

export function renderJoin({ signedIn = false, accountLabel, displayName, csrf, importJob } = {}) {
  return base('Join Unlinked', `<section class="narrow">${steps(1)}<h1 class="hq">Join Unlinked</h1><p class="lead">Bring the people you know into reach.</p><div class="sign-in-options"><a class="button" href="/login">Sign in with Ideaflow</a></div><p class="small">One button for new and returning members. Google, email and password are all on the Ideaflow sign-in page, the same account as OpenChat.</p>${!signedIn ? exportHelp() : ''}<p class="small"><a href="/people">Explore profiles first</a></p></section>`, signedIn ? { accountLabel, displayName, csrf, importJob } : { signInInBody: true })
}

// A member page was opened without a session. Sign-in returns to that page.
export function renderSignInRequired({ next } = {}) {
  const target = localAction(next) ? `/login?next=${encodeURIComponent(next)}` : '/login'
  return base('Sign in to continue', `<section class="narrow"><h1 class="hq">Sign in to continue</h1><p class="lead">This page belongs to your account. Anyone can search and read profiles without signing in.</p><div class="sign-in-options"><a class="button" href="${html(target)}">Sign in with Ideaflow</a></div><p class="small">New here? The same button creates your account. <a href="/people">Explore profiles</a></p></section>`, { signInInBody: true })
}

export function renderBringArchive({ accountLabel, displayName, csrf, publicProfessionalSearch = false, limitBytes = 67108864, state = 'ready', errorMessage, syntheticMode = false, importJob }) {
  const size = Number.isSafeInteger(limitBytes) && limitBytes > 0 ? Math.floor(limitBytes / 1048576) : 64
  return base('Bring your LinkedIn export', `<section class="narrow">${steps(2)}<h1 class="hq">Bring your LinkedIn export</h1><p class="lead">Your full LinkedIn ZIP builds your profile and brings your connections. Connections-only ZIP or CSV also works.</p>${state === 'error' ? `<p class="notice error" role="alert">${html(errorMessage) || 'That file could not be imported. Try again, or choose Connections.csv from your archive.'}</p>` : ''}<form id="onboarding-upload" method="post" action="/upload" enctype="multipart/form-data">${csrfInput(csrf)}<label class="file">Choose your LinkedIn file<input required type="file" name="archive" accept=".zip,.csv"><span class="small">ZIP or CSV · up to ${size} MB</span></label>${syntheticMode ? '<label><input required type="checkbox" name="syntheticConsent" value="yes"> This is synthetic test data.</label>' : ''}<button id="onboarding-import" type="submit">Import my file</button><p class="small">${publicProfessionalSearch ? 'By importing, your profile and the people in your file can be found on Unlinked by members and visitors. Contact details and your original file stay private.' : 'By importing, your profile and connections join your Unlinked network, searchable by you and by any agent you connect. Contact details stay private.'}</p><section id="onboarding-progress" hidden role="status" aria-live="polite"><h2>Importing…</h2><progress aria-label="Importing your LinkedIn file"></progress><p>Uploading your file. Keep this page open until the upload finishes; the import then continues on the server.</p></section></form>${exportHelp()}<details><summary>Don’t have your export yet?</summary>${exportSteps()}</details><p><a href="/profile">Skip for now</a> · <a href="/network">Explore people</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

export function renderImporting({ accountLabel, displayName, csrf, importJob } = {}) {
  const finished = terminalJob(importJob)
  const message = importJob?.status === 'indexed' ? 'Your import is ready. Open People to search your connections.' : rowsSkipped(importJob) ? 'Your import is ready. A few rows had no name or LinkedIn address and were skipped; Settings lists the file.' : importJob?.status === 'partial' ? 'Your import did not finish completely. Review the import details in Settings.' : 'Your file could not be imported. Review the error above and try adding your file again.'
  const title = finished ? jobLabel(importJob) : 'Importing…'
  return base(title, `<section class="narrow">${steps(2)}<h1 class="hq">${title}</h1><div class="panel" role="status">${finished ? `<p>${message}</p><a href="${importJob.status === 'indexed' ? '/network' : '/settings'}">${importJob.status === 'indexed' ? 'Open People' : 'Open Settings'}</a>` : `<p>Reading your profile and connections.</p><p>Your profile is ready as soon as your file is read.</p><p>You can leave this page. The import keeps running.</p>${importJob?.profileReady ? '<a class="button" href="/profile">See your profile</a>' : ''}`}</div><p><a href="/network">Explore people while you wait</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

export function uploadProgressScript() {
  return `const form=document.getElementById('onboarding-upload');if(form){form.addEventListener('submit',()=>{if(!form.reportValidity())return;const button=document.getElementById('onboarding-import');button.disabled=true;button.textContent='Importing…';document.getElementById('onboarding-progress').hidden=false;});}`
}

// Install separately with the controller's CSP nonce; the textarea is usable without it.
export function agentSetupCopyScript() {
  return `for(const button of document.querySelectorAll('[data-copy-target]')){
    const field=document.getElementById(button.getAttribute('data-copy-target'));
    const help=document.getElementById(button.getAttribute('data-copy-help'));
    if(!field||!help)continue;
    button.addEventListener('click',async()=>{
      field.focus();field.select();
      try{await navigator.clipboard.writeText(field.value);help.textContent='Copied.';}
      catch{
        for(let parent=field.closest?.('details');parent;parent=parent.parentElement?.closest('details'))parent.open=true;
        if(field.type==='password'){
          field.type='text';const toggle=document.querySelector('[data-reveal-target="'+field.id+'"]');
          if(toggle){toggle.textContent='Hide';toggle.setAttribute('aria-pressed','true');}
        }
        field.focus();field.select();help.textContent='Selected. Copy it from the field above.';
      }
    });
  }
  for(const button of document.querySelectorAll('[data-reveal-target]')){
    button.addEventListener('click',()=>{
      const field=document.getElementById(button.dataset.revealTarget),show=field.type==='password';
      field.type=show?'text':'password';button.textContent=show?'Hide':'Show';button.setAttribute('aria-pressed',String(show));
    });
  }`
}

// One copyable value: a readonly field plus a copy button wired by agentSetupCopyScript.
function copyField(id, label, value, rows = 1) {
  return `<label for="${id}">${label}</label><textarea id="${id}" readonly rows="${rows}" spellcheck="false">${html(value)}</textarea><button type="button" class="quiet" data-copy-target="${id}" data-copy-help="${id}-help" aria-label="Copy ${html(label)}" aria-describedby="${id}-help">Copy</button><p id="${id}-help" class="small" role="status"></p>`
}

// Per-client setup from one grant (see agentClientSetups). Claude Desktop's
// claude_desktop_config.json only runs local stdio servers, so it gets a
// connector (no install) or an mcp-remote stdio entry — never the url/headers
// JSON, which Claude Desktop skips as "not a valid MCP server configuration".
function agentClientSections(setups, genericSerialized, connector = false) {
  const generic = `<details><summary><b>Cursor and other MCP clients</b> (config file with a server URL)</summary><p>For clients whose MCP config file accepts a remote server <code>url</code> with <code>headers</code>, such as Cursor’s <code>mcp.json</code>. Not for Claude Desktop’s <code>claude_desktop_config.json</code>.</p><label for="onboarding-agent-configuration">Agent configuration</label><textarea id="onboarding-agent-configuration" readonly rows="8" spellcheck="false">${html(genericSerialized)}</textarea><p id="onboarding-copy-help" class="small" role="status">You can also select and copy the setup above.</p></details>`
  if (!setups) return generic
  return `<p>${connector ? 'For apps that cannot sign in, or setups you script yourself.' : 'Pick the app you use.'} Every option uses the same private credential.</p>`
    + `<details${connector ? '' : ' open'}><summary><b>Claude</b> — ${connector ? 'custom connector with a request header instead of signing in' : 'Claude Desktop or claude.ai (recommended, nothing to install)'}</summary><ol><li>In Claude, open <b>Customize → Connectors</b>, choose <b>+ Add</b>, then <b>Add custom connector</b>.</li><li>Name it <b>Unlinked</b> and paste the server URL:${copyField('agent-setup-url', 'Remote MCP server URL', setups.url)}</li><li>Under <b>Authentication</b>, choose <b>No sign in</b>.</li><li>Under <b>Request headers</b>, add a header named <code>Authorization</code> with this value:${copyField('agent-setup-claude-header', 'Authorization header value', setups.authorization, 2)}</li><li>Save, then switch Unlinked on from the connectors menu in a chat.</li></ol><p class="small">On Team and Enterprise plans an owner first adds the connector under Organization settings → Connectors.</p></details>`
    + `<details><summary><b>Claude Desktop config file</b> (<code>claude_desktop_config.json</code>)</summary><p>Use this instead of a connector if you prefer a local setup. It needs <a href="https://nodejs.org/" target="_blank" rel="noopener noreferrer">Node.js</a> 18 or newer.</p><ol><li>In Claude Desktop open <b>Settings → Developer → Edit Config</b>.</li><li>If the file is empty, paste everything below. If it already has <code>"mcpServers"</code>, add only the <code>"unlinked"</code> entry inside it.</li><li>Quit Claude Desktop completely and open it again.</li></ol>${copyField('agent-setup-claude-desktop', 'claude_desktop_config.json', JSON.stringify(setups.claudeDesktop, null, 2), 12)}<p class="small">Claude Desktop only runs local commands from this file; it skips server entries that are just a URL.</p></details>`
    + `<details><summary><b>Claude Code</b>${connector ? ' with a request header' : ''}</summary><p>Run this in a terminal:</p>${copyField('agent-setup-claude-code', 'Command', setups.claudeCode, 4)}</details>`
    + '<p>For a client with an API-key or access-token field, use <b>Copy API key</b> above. For a full Authorization header value, use the header example. Do not paste configuration JSON into a key field.</p>'
    + generic
}

// OAuth connector setup (mcp-server/oauth-server.mjs): the primary way to
// connect Claude and ChatGPT. Only the public server URL is shown; signing in
// and approving happens in the app's own connect flow.
// What a grant scope covers, in words (scope grammar: account-grants.mjs).
const scopeLabel = scope => {
  const parsed = parseAccountScope(scope)
  if (!parsed) return 'your network'
  const parts = ['your network', ...(parsed.public ? ['People'] : []), ...(parsed.write ? ['connection actions'] : []), ...(parsed.privateNotes ? ['private notes & relations'] : [])]
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
const day = seconds => Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : ''
function connectorSection(connector, connections, csrf) {
  const url = connector.url
  const apps = list(connections).map(value => `<form method="post" action="/revoke-account">${csrfInput(csrf)}<input type="hidden" name="grantId" value="${html(value.id)}"><p><b>${html(value.connection.app)}</b>${value.connection.app === 'An app on this computer' && value.connection.clientName ? ` (“${html(value.connection.clientName)}”)` : ''} · connected ${html(day(value.issuedAt))} · ${html(scopeLabel(value.scope))}</p><button class="quiet">Disconnect</button></form>`).join('')
  return `<p><b>Claude and ChatGPT: paste this address, then sign in.</b> No API key is needed for sign-in.</p>${copyField('agent-connector-url', 'Unlinked MCP server URL', url)}`
    + `<details><summary><b>Claude</b> — claude.ai, Claude Desktop and mobile</summary><ol><li>In Claude open <b>Settings → Connectors</b> (in Claude Desktop also <b>Customize → Connectors</b>) and choose <b>Add custom connector</b>.</li><li>Name it <b>Unlinked</b> and paste the URL above. Leave the advanced OAuth fields empty.</li><li>Choose <b>Add</b>, then <b>Connect</b>. Sign in to Unlinked if asked and choose <b>Allow</b>.</li><li>In a chat, switch Unlinked on from the connectors menu.</li></ol><p class="small">On Team and Enterprise plans an owner first adds the connector under Organization settings → Connectors.</p></details>`
    + `<details><summary><b>ChatGPT</b> — developer mode</summary><ol><li>In ChatGPT settings, turn on <b>Developer mode</b> (Apps &amp; Connectors → Advanced settings).</li><li>Create a connector named <b>Unlinked</b> with the URL above and <b>OAuth</b> authentication.</li><li>Sign in to Unlinked if asked and choose <b>Allow</b>.</li></ol></details>`
    + `<details><summary><b>Claude Code</b></summary>${copyField('agent-connector-claude-code', 'Command', `claude mcp add --transport http unlinked ${url}`, 2)}<p class="small">Then run <code>/mcp</code> in Claude Code, choose <b>unlinked</b> and sign in.</p></details>`
    + `<h3>Connected apps</h3>${apps || '<p class="small">No apps connected yet. Each app you connect appears here; disconnecting stops it immediately.</p>'}`
}

// Not the right account? Signs out here, then opens the Ideaflow account
// chooser and comes back to `next` (re-validated as a local return page by the
// runtime, so it can never become an open redirect).
const switchAccount = (csrf, next) => `<form class="switch-account" method="post" action="/switch-account">${csrfInput(csrf)}<input type="hidden" name="next" value="${html(next)}"><button class="link-button" type="submit">Not you? Switch account</button></form>`

// Consent for one OAuth authorization request. `request` comes from
// oauth.readAuthorization; the app label is derived from the verified redirect
// target, and the loopback case also shows the app's self-reported name.
export function renderConnectorConsent({ accountLabel, displayName, csrf, importJob, request, offerConnections = false }) {
  const named = request.loopback && request.clientName ? ` (it calls itself “${html(request.clientName)}”)` : ''
  const hidden = [...request.params].map(([key, value]) => `<input type="hidden" name="${html(key)}" value="${html(value)}">`).join('')
  return { ...base(`Connect ${request.app} to Unlinked`, `<section class="narrow"><h1 class="hq">Connect ${html(request.app)} to Unlinked</h1><p class="lead"><b>${html(request.app)}</b>${named} wants to use your Unlinked account.</p><div class="card"><p>Signed in as <b>${html(accountLabel)}</b>.</p>${switchAccount(csrf, `/oauth/authorize?${new URLSearchParams([...request.params])}`)}<h3>It will be able to</h3><ul>${request.scopes.map(scope => `<li>${html(scope.description)}</li>`).join('')}</ul><h3>It will not be able to</h3><ul><li>See your original files, contact email addresses or phone numbers.</li><li>Send messages or post (messaging is OpenChat, through the shared Ideaflow connector). Connection requests require the separate opt-in below.</li></ul>${request.loopback ? '<p class="notice">Only allow this if you started connecting an app on this computer just now.</p>' : ''}<form method="post" action="/oauth/authorize">${csrfInput(csrf)}${hidden}<label><input type="checkbox" name="private_notes" value="on" checked> Private people notes &amp; relations</label><p class="small">${html(request.privateNotesDescription ?? '')} Agent-written notes are labelled with the app’s name. Untick to leave them out; change it later by reconnecting.</p>${offerConnections ? '<label><input type="checkbox" name="access" value="connections"> Allow connection actions: send, accept, ignore and withdraw requests</label><p class="small">Optional and off by default. Uses the same rules and daily limits as the site.</p>' : ''}<div class="actions"><button name="decision" value="allow">Allow</button><button class="quiet" name="decision" value="deny">Cancel</button></div></form><p class="small">After you choose, you return to <b>${html(request.redirectHost)}</b>. Disconnect it any time in <a href="/settings">Settings</a>; searches it makes use OpenAI as described there.</p></div></section>`, { accountLabel, displayName, csrf, importJob }), formAction: request.loopback ? new URL(request.redirectUri).origin : 'https:' }
}

export function renderConnectorError({ accountLabel, displayName, csrf, importJob, message }) {
  return base('This connection could not start', `<section class="narrow"><h1 class="hq">This connection could not start</h1><p class="lead">${html(message)}</p><p>Nothing was shared. Remove Unlinked from the app's connectors and add it again with <code>https://www.unlinked.ai/mcp</code>.</p><p><a class="button" href="/settings">Open Settings</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

export function renderOwnProfile({ accountLabel, displayName, csrf, publicProfessionalSearch = false, profile = {}, publicProfileUrl, contacts = [], connectionCount, imports = [], importJob, linkedinLookup, lookupResult, testClaim }) {
  const people = list(contacts), files = list(imports).length
  const total = Number.isSafeInteger(connectionCount) && connectionCount >= people.length ? connectionCount : people.length
  const facts = [raw(profile.location), raw(profile.industry), total ? `${count(total)} ${total === 1 ? 'connection' : 'connections'}` : ''].filter(Boolean).join(' · ')
  return base("Here's your profile", `<section class="profile"><div><div class="card phead"><div class="banner"></div>${profileFace(profile)}<h1>${html(profile.name) || 'Your profile'}</h1>${profile.headline ? `<p class="hl">${html(profile.headline)}</p>` : ''}${facts ? `<span class="small">${html(facts)}</span>` : ''}${profile.company ? `<p class="small">${companyLink(profile.company)}</p>` : ''}${profileLinks(profile)}${testClaim?.name ? `<p class="notice test-claim" role="status"><b>Test profile claimed:</b> ${html(testClaim.name)}. This is test data. It is not public and is not part of your profile, network or agent.</p>` : ''}<div class="actions"><a class="button" href="/network">Looks good</a><a class="button sec" href="/card">My card</a>${openChatAction(publicProfileUrl)}<a class="button sec" href="/import">${files ? 'Add another file' : 'Bring my LinkedIn export'}</a><a class="button sec" href="/settings">Connect my agent</a></div>${openChatNote(publicProfileUrl)}<p class="notice">Built from your file. Fix anything later. <span class="small">Editing comes soon.</span></p></div>${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, 'A full archive can include your experience.')}${education(profile.education)}${skills(profile.skills)}${profileLookup({ linkedinLookup, lookupResult, csrf })}</div><aside><div class="card sec"><h3>My connections${total ? ` · ${count(total)}` : ''}</h3>${people.length ? `${people.slice(0, 10).map(connectionRow).join('')}<p class="small"><a href="/network">See all the people you know →</a></p>` : '<p class="small">Bring your LinkedIn export to fill this in.</p><p><a href="/import">Add a file →</a></p>'}</div><p class="small">${files ? `${files} ${files === 1 ? 'file has' : 'files have'} been added to your account.` : 'You can add your file later.'} ${publicProfessionalSearch ? 'Contact details and your original file stay private.' : 'Your people remain private to your account.'}</p></aside></section>`, { accountLabel, displayName, csrf, importJob })
}

// The signed-in member's card, in two versions.
//
// Public: their public professional identity plus a QR code for it. `qr` is
// trusted server-rendered SVG markup built from the verified public profile
// URL; everything else is escaped. No contact details appear, and scanning the
// code only opens the same public profile page any visitor can read.
//
// Contact: the business-card version, with the phone number, WhatsApp, email
// address and link the member switched on (mcp-server/contact-card.mjs). Its QR
// opens /c/<token>, a link only the member hands out. Those details are shown
// nowhere else.
const CARD_ICON = {
  phone: '<path d="M6.2 2.8 4.4 3.3a1.6 1.6 0 0 0-1.1 1.9c1.1 4.8 4.7 8.4 9.5 9.5a1.6 1.6 0 0 0 1.9-1.1l.5-1.8-3.2-1.5-1.3 1.5a8 8 0 0 1-3.9-3.9l1.5-1.3z"/>',
  whatsapp: '<path d="M3 15l.9-3.1A6.3 6.3 0 1 1 6.2 14z"/><path d="M7 6.6c0 2.2 1.9 4 4 4.3l.8-1.1-1.5-.8-.6.5a3 3 0 0 1-1.4-1.4l.5-.6-.7-1.5z"/>',
  email: '<rect x="2.5" y="4" width="13" height="10" rx="1.5"/><path d="m3 5 6 4.6L15 5"/>',
  link: '<path d="M7.6 10.4a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2l-.8.8M10.4 7.6a3 3 0 0 0-4.2 0L4 9.8A3 3 0 0 0 8.2 14l.8-.8"/>',
  linkedin: '<rect x="2.5" y="2.5" width="13" height="13" rx="2"/><path d="M6 8.2V12M6 5.7v.1M9.2 12V9.9c0-.9.7-1.6 1.6-1.6.9 0 1.6.7 1.6 1.6V12"/>',
}
const cardIcon = name => `<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CARD_ICON[name]}</svg>`
const linkLabel = value => { try { const url = new URL(value); return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}` } catch { return '' } }
const cardRow = (icon, href, value, label, external = false) => `<li><a class="bc-row" href="${html(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}><span class="bc-ico">${cardIcon(icon)}</span><span><b>${html(value)}</b><span class="small">${label}</span></span></a></li>`
// The details a link holder sees. `card` is the consent projection, nothing else.
const contactRows = card => [
  card?.phone ? cardRow('phone', `tel:${card.phone}`, displayPhone(card.phone), 'Phone') : '',
  card?.whatsapp ? cardRow('whatsapp', whatsappUrl(card.whatsapp), displayPhone(card.whatsapp), 'WhatsApp', true) : '',
  card?.email ? cardRow('email', `mailto:${card.email}`, card.email, 'Email') : '',
  card?.link && isSafeContactLink(card.link) ? cardRow('link', card.link, linkLabel(card.link), 'Link', true) : '',
  linkedinRow(card?.linkedinUrl),
].join('')
// The person's LinkedIn address, already part of their public identity.
const linkedinRow = value => { const url = publicLinkedinUrl(value); return url ? cardRow('linkedin', url, linkLabel(url), 'LinkedIn', true) : '' }
// One business card: who it is, optional detail rows, optional side panel.
const businessCard = ({ name, headline, location, photo, heading = 'h1', rows = '', side = '', empty = 'Your card' }) => `<div class="bcard${side ? '' : ' solo'}"><div class="bc-main"><div class="bc-id">${photoSrc(photo) ? photoImg('bc-av photo', photo, name, 64) : `<span class="bc-av" aria-hidden="true">${html(initials(name)) || '·'}</span>`}<div><${heading} class="bc-name">${html(name) || empty}</${heading}>${raw(headline) ? `<p class="bc-hl">${html(headline)}</p>` : ''}${raw(location) ? `<p class="small">${html(location)}</p>` : ''}</div></div>${rows ? `<ul class="bc-rows">${rows}</ul>` : ''}</div>${side ? `<div class="bc-side">${side}</div>` : ''}</div>`
// The public card face, shared by /card and the My card tab of /scan.
const cardFace = ({ profile = {}, cardUrl, qr, heading = 'h1', actions }) =>
  `${businessCard({ name: profile.name, headline: profile.headline, location: profile.location, photo: profile.photo, heading, rows: linkedinRow(profile.linkedinUrl), side: cardUrl && qr ? `<div class="qr">${qr}</div><p class="small">Scan to open my public profile</p>` : '' })}${cardUrl && qr ? `<p class="small qr-url"><code>${html(cardUrl)}</code></p>` : '<p class="notice">Your QR code appears once your profile is published on Unlinked. Bring your LinkedIn export to publish it.</p>'}<div class="actions">${actions}</div><p class="small">This card shows only what is already public: no phone number, email address or file contents.</p>`
const CONTACT_FIELDS = [
  ['phone', 'showPhone', 'Phone', 'tel', 'tel', '+1 415 555 0123', 'With the country code.'],
  ['whatsapp', 'showWhatsapp', 'WhatsApp', 'tel', 'off', 'Same as phone', 'Leave the number empty to use your phone number.'],
  ['email', 'showEmail', 'Email', 'email', 'email', 'you@example.com', ''],
  ['link', 'showLink', 'Website or link', 'url', 'url', 'https://example.com', ''],
]
// An empty field starts switched on (it shows nothing until it is filled in);
// WhatsApp starts off, since it can borrow the phone number.
const contactForm = (settings, csrf) => `<form class="card cc-form" method="post" action="/card/contact">${csrfInput(csrf)}${CONTACT_FIELDS.map(([field, show, label, inputmode, autocomplete, placeholder, hint]) => {
  const on = settings[show] === true || (field !== 'whatsapp' && !raw(settings[field]))
  return `<div class="cc-field"><label for="cc-${field}">${label}${hint ? ` <span class="small">${hint}</span>` : ''}</label><input id="cc-${field}" type="text" name="${field}" inputmode="${inputmode}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false" maxlength="254" placeholder="${html(placeholder)}" value="${html(settings[field])}"><label class="check"><input type="checkbox" name="${show}" value="yes"${on ? ' checked' : ''}> Show on my contact card</label></div>`
}).join('')}<div class="actions"><button type="submit">Save</button></div><p class="small">To hide a detail, switch it off and save. With everything off, your contact card link shows nothing.</p></form>`
export function renderCard({ accountLabel, displayName, csrf, importJob, profile = {}, cardUrl, qr, contact = null, share = 'contact', notice, error }) {
  const onContact = Boolean(contact) && share === 'contact'
  const tab = (href, label, selected) => `<a href="${href}"${selected ? ' aria-current="page"' : ''}>${label}</a>`
  const tabs = contact ? `<nav class="tabs" aria-label="Card version">${tab('/card?share=public', 'Public', !onContact)}${tab('/card?share=contact', 'With contact details', onContact)}</nav>` : ''
  const details = `${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, '')}${education(profile.education)}${skills(profile.skills)}`
  const scan = '<a class="button sec sm" href="/scan">Scan someone’s card</a>'
  // Shown by TOP_BAR_SCRIPT on phones only, when the page is not already running
  // as the installed app and the member has not dismissed it.
  const pwaHint = `<div id="pwa-hint" class="notice pwa-hint" hidden><span><b>Keep your card one tap away.</b> In your browser’s Share or menu, choose Add to Home Screen.</span><button id="pwa-hint-dismiss" type="button" class="quiet sm" aria-label="Dismiss">Not now</button></div>`
  if (!onContact) {
    const actions = `${cardUrl ? `<a class="button sec sm" href="${html(cardUrl)}">Preview my public profile</a>` : '<a class="button sm" href="/import">Add my file</a>'}${scan}`
    return base('My card', `<section class="narrow wide">${pwaHint}<h1 class="hq">My card</h1>${tabs}<p class="lead">Show this code to someone you meet. Scanning it opens your public Unlinked profile — nothing more.</p>${cardFace({ profile, cardUrl, qr, heading: 'h2', actions })}${details}</section>`, { accountLabel, displayName, csrf, importJob })
  }
  const live = Boolean(contact.card && contact.shareUrl)
  const face = businessCard({ name: profile.name, headline: profile.headline, location: profile.location, photo: profile.photo, heading: 'h2', rows: contactRows(contact.card),
    side: live && contact.qr ? `<div class="qr">${contact.qr}</div><p class="small">Scan to open this card and save my details</p>` : '' })
  const link = live ? `<label for="cc-link-out">Link to this card</label><input id="cc-link-out" type="text" readonly value="${html(contact.shareUrl)}"><div class="actions"><a class="button sec sm" href="${html(contact.shareUrl)}">See what they see</a>${scan}</div>` : `<p class="notice">Nothing is shared yet. Add a detail below and save; your contact card then gets its own QR code and link.</p><div class="actions">${scan}</div>`
  const reset = live ? `<details class="cc-reset"><summary>Reset the link…</summary><p class="small">You get a new link and QR code. The old ones stop working for everyone who has them.</p><form method="post" action="/card/contact/reset">${csrfInput(csrf)}<button class="quiet sm" type="submit">Reset my contact card link</button></form></details>` : ''
  return base('My card', `<section class="narrow wide">${pwaHint}<h1 class="hq">My card</h1>${tabs}<p class="lead">For people you choose. This version carries the contact details you switch on, and only someone with its code or link can open it and add you to their connections. Your public profile never shows these details.</p>${notice ? `<p class="notice" role="status">${html(notice)}</p>` : ''}${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}${face}${link}${details}<h2>What this card shares</h2>${contactForm(contact.settings ?? {}, csrf)}${reset}</section>`, { accountLabel, displayName, csrf, importJob })
}

// What a contact card link opens, signed in or not. `card` is the consent
// projection (or null: unknown, reset, or nothing shown). Never indexed.
export function renderContactCard({ accountLabel, displayName, csrf, card, token, canAdd = false, relation, addError = false } = {}) {
  if (!card) return base('Contact card', `<section class="narrow"><h1 class="hq">This card is not available</h1><p class="lead">Its owner may have reset the link or stopped sharing. Ask them for a new one.</p><p><a href="/">Learn about Unlinked</a></p></section>`, { accountLabel, displayName, csrf })
  const first = firstName(card.name)
  const add = canAdd && relation !== 'self' ? relation === 'connected' ? '<p class="notice" role="status">Added to your connections.</p><p><a href="/network?connected=1">View my connections →</a></p>' : `<form method="post" action="/c/${html(token)}/add">${csrf ? csrfInput(csrf) : ''}<button type="submit">${csrf ? `Add ${html(first || card.name || 'this person')} to my connections` : `Sign up &amp; add ${html(first || card.name || 'this person')}`}</button><p class="small">${csrf ? 'Their shared card lets you connect right away.' : 'Create an account or sign in with Ideaflow. We’ll add this person automatically when you return. No LinkedIn import needed.'}</p></form>` : ''
  return base(raw(card.name) || 'Contact card', `<section class="narrow"><p class="ph cc-kicker">Contact card</p>${businessCard({ name: card.name, headline: card.headline, location: card.location, rows: contactRows(card), empty: 'Unlinked member' })}${addError ? '<p class="notice error" role="alert">We couldn’t add this person. Please try again.</p>' : ''}${add}<div class="actions"><a class="button sec" href="${html(`/c/${raw(token)}/contact.vcf`)}">Save contact</a>${card.profilePath ? `<a class="button sec" href="${html(card.profilePath)}">View profile</a>` : ''}</div><p class="small cc-foot">${first ? `${html(first)} shared` : 'Shared'} with you through an Unlinked contact card. These details are not on a public profile; please keep them to yourself.</p>${csrf ? '' : '<p class="small">Unlinked is an open professional network. <a href="/join">Make your own card →</a></p>'}</section>`, { accountLabel, displayName, csrf })
}

// The early, optional find-yourself step: a LinkedIn address is a lookup hint,
// never proof of ownership or an import. Nothing is claimed without the
// explicit "Yes, that's me" confirmation, and skipping costs nothing.
// Someone you know who is not on Unlinked: kept with your own people, never
// published. LinkedIn's own export format needs both names and the profile URL.
export function renderAddPerson({ accountLabel, displayName, csrf, importJob, error, values = {} } = {}) {
  const field = (name, label, hint, required = false, type = 'text') => `<label>${label}${required ? '' : ' <span class="small">(optional)</span>'}<input name="${name}" type="${type}" maxlength="${type === 'url' ? 2048 : 120}"${required ? ' required' : ''} value="${html(values[name])}">${hint ? `<span class="small">${hint}</span>` : ''}</label>`
  return base('Add a person', `<section class="narrow"><h1 class="hq">Add a person</h1><p class="lead">Someone you know who is not on Unlinked. They join your own people, searchable by you and your agent. They are not published, and they are not told. Only a name is needed.</p>${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}<form method="post" action="/people/add">${csrfInput(csrf)}${field('firstName', 'First name', '', true)}${field('lastName', 'Last name')}${field('linkedinUrl', 'LinkedIn profile', 'For example https://www.linkedin.com/in/their-name', false, 'url')}${field('company', 'Company')}${field('position', 'Role')}<button type="submit">Add to my people</button></form><p class="small"><a href="/invites">Invite someone to join instead →</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

const INVITATION_STATUS = { pending: 'Waiting', accepted: 'Accepted', declined: 'Declined', revoked: 'Revoked', expired: 'Expired' }
// Invites: a link the member sends, or (while email is on) one Unlinked emails
// for them. The invitee's address is never echoed back into the page.
const INVITE_EMAIL_RESULT = {
  sent: 'We emailed the invite for you, from your name “via Unlinked”.',
  unavailable: 'We did not email it: this address cannot get an invite email from Unlinked right now. Send the link yourself.',
  member_limit: 'We did not email it: you have reached today’s limit of invite emails. Send the link yourself.',
  site_limit: 'We did not email it: Unlinked has sent all the invite emails it sends in a day. Send the link yourself.',
  failed: 'We could not email it just now. Send the link yourself.',
}
export function renderInvites({ accountLabel, displayName, csrf, importJob, invitations = [], created, error, emailed, emailInvites = false, replyAddress = null, origin = 'https://www.unlinked.ai' } = {}) {
  const link = created ? `${raw(origin)}/i/${raw(created.token)}` : ''
  const emailNote = emailed ? `<p class="notice${emailed.sent ? '' : ' error'}">${html(INVITE_EMAIL_RESULT[emailed.sent ? 'sent' : emailed.reason] ?? INVITE_EMAIL_RESULT.failed)}</p>` : ''
  const fresh = created ? `<div class="card" role="status">${emailNote}<p><strong>Invite link for ${html(created.invitation.inviteeName)} is ready.</strong> ${emailed?.sent ? 'You can also send this link yourself.' : 'Send this link yourself.'} It works once, and it is shown only now.</p><label for="invite-link">Invite link</label><input id="invite-link" readonly value="${html(link)}"><p class="actions"><a class="button sec sm" href="${html(`mailto:?subject=${encodeURIComponent('Join me on Unlinked')}&body=${encodeURIComponent(`I'd like to connect on Unlinked: ${link}`)}`)}">Write an email</a></p></div>` : ''
  const rows = list(invitations).map(value => `<div class="row"><span>${html(value.inviteeName)}</span><b>${html(INVITATION_STATUS[value.status] ?? value.status)}</b>${value.status === 'pending' ? `<form method="post" action="/invites/revoke">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(value.id)}"><button class="quiet sm">Revoke</button></form>` : ''}</div>`).join('')
  return base('Invite someone', `<section class="narrow wide"><h1 class="hq">Invite someone</h1><p class="lead">Invite someone who is not on Unlinked yet. You get a link to send them yourself${emailInvites ? ', or we can email it for you' : ''}.</p>${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}${fresh}<form method="post" action="/invites">${csrfInput(csrf)}<label>Their name<input name="inviteeName" required maxlength="120"></label>${emailInvites ? `<label>Their email <span class="small">(optional) We email the invite for you, from your name. We do not keep their address. ${replyAddress ? `Replies go to <b>${html(replyAddress)}</b>, so they will see your address.` : 'We have no verified address for you, so they cannot reply to the email.'}</span><input name="inviteeEmail" type="email" maxlength="254" autocomplete="off" autocapitalize="off" spellcheck="false"></label>` : ''}<button type="submit">${emailInvites ? 'Create invite' : 'Create invite link'}</button></form><h2>Your invites</h2><div class="card">${rows || '<p class="small">No invites yet.</p>'}</div><p class="small">When they accept, you are connected on Unlinked, and the connection shows on both your profiles. Accepting never claims a profile for them. <a href="/people/add">Add someone to your people instead →</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

// The page an invite link opens, signed in or not.
export function renderInviteLanding({ accountLabel, displayName, csrf, token, invitation, outcome } = {}) {
  const valid = invitation?.status === 'pending'
  const path = `/i/${raw(token)}`
  const body = outcome === 'accepted' ? `<p class="lead">You accepted ${html(invitation.inviterName)}'s invite. You're now connected.</p><p><a class="button" href="/profile">Continue to your profile</a></p>`
    : outcome === 'declined' ? '<p class="lead">You declined the invite. Nothing was linked to your account.</p>'
    : invitation?.status === 'own' ? '<p class="lead">This is your own invite. Send the link to the person you invited.</p><p><a href="/invites">Your invitations</a></p>'
    : !valid ? `<p class="lead">This invite ${invitation?.status === 'expired' ? 'has expired' : 'is no longer available'}.</p><p><a href="/">Learn about Unlinked</a></p>`
    : `<p class="lead">${html(invitation.inviterName)} invited ${html(invitation.inviteeName)} to Unlinked, an open professional network.</p>${csrf
      ? `<form method="post" action="${html(path)}">${csrfInput(csrf)}<p class="small">Signed in as ${html(accountLabel)}. Accepting connects you with ${html(invitation.inviterName)}; the connection shows on both your profiles. It does not claim any profile for you.</p><div class="actions"><button name="action" value="accept">Accept</button><button class="quiet" name="action" value="decline">Decline</button></div></form>`
      : `<div class="actions"><a class="button" href="${html(`/login?next=${encodeURIComponent(path)}`)}">Sign in or join to accept</a></div><p class="small">Unlinked asks you to confirm after you sign in.</p>`}`
  return base('Invite', `<section class="narrow"><h1 class="hq">You're invited</h1>${body}</section>`, { accountLabel, displayName, csrf })
}

export function renderFindMe({ accountLabel, displayName, csrf, importJob, lookupResult, notice, address = '' } = {}) {
  return base('Find your profile', `<section class="narrow"><h1 class="hq">Find yourself on Unlinked</h1><p class="lead">Paste your LinkedIn address. Claim your original Unlinked profile, or start with your public LinkedIn profile. Your export can fill in the rest later.</p>${notice ? `<p class="notice">${html(notice)}</p>` : ''}${profileLookup({ linkedinLookup: { action: '/find-me' }, lookupResult, csrf, address })}${lookupResult?.status === 'none' ? `<p class="notice" role="status">${html(lookupResult.notice ?? 'Nothing unclaimed matched. You can continue — your LinkedIn export builds your profile either way.')}</p>` : ''}<p class="small"><a href="/profile">Skip for now →</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

// Anyone's profile, readable with or without a session: who they are and who they know.
// The Connect control on someone else's profile, by where the two accounts stand.
const CONNECT_NOTICES = {
  removed: 'Connection removed for both of you. You can send a new request. Imported connection observations stay in your files.', sent: 'Request sent. They will see it in My Network and Notifications.', accepted: 'You are now connected.', withdrawn: 'Invitation withdrawn.', ignored: 'Invitation ignored.',
  connection_pending: 'You already have an invitation waiting with them.', connection_exists: 'You are already connected.', connection_self: 'That is your own profile.',
  connection_rate_limited: 'You have sent a lot of invitations today. Try again tomorrow.', connection_cooldown: 'You withdrew an invitation to them recently. You can invite them again in a few weeks.',
  connection_note_invalid: 'Keep the note under 300 characters.', connection_unavailable: 'That invitation is no longer available.', connection_not_found: 'That invitation is no longer available.', connection_not_member: 'They are not on Unlinked yet.',
}
export const connectNoticeCodes = Object.freeze(Object.keys(CONNECT_NOTICES))
const connectControl = ({ connect, csrf, id, name, next, row = false }) => {
  if (!connect) return ''
  const back = `<input type="hidden" name="next" value="${html(next ?? `/people/${encodeURIComponent(id)}`)}">`
  if (connect.state === 'signed-out') return `<a class="button sm" href="${html(`/login?next=${encodeURIComponent(`/people/${encodeURIComponent(id)}`)}`)}">Sign in to connect</a>`
  if (connect.state === 'self') return '<a class="button sec sm" href="/profile">This is you · My profile</a>'
  if (connect.state === 'connected') return `<span class="state-pill ok">✓ Connected</span>${connect.requestId ? `<details class="connection-remove"><summary>Remove connection…</summary><p>Remove ${html(name || 'this person')} from your member connections? This removes the connection for both of you. Nobody is notified. Your imported files and claimed profiles stay.</p><form method="post" action="/connections/remove">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}">${back}<button class="quiet sm">Confirm removal</button></form></details>` : ''}`
  if (connect.state === 'outgoing') return `<span class="state-pill">Request sent · Pending</span><form method="post" action="/connections/withdraw">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}">${back}<button class="quiet sm" type="submit">Withdraw</button></form>`
  if (connect.state === 'incoming') return `<form method="post" action="/connections/respond">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}">${back}<button class="sm" name="action" value="accept">Accept invitation</button><button class="quiet sm" name="action" value="ignore">Ignore</button></form>`
  if (connect.state === 'none') return `<form${row ? '' : ' id="connect-form"'} class="connect" method="post" action="/connections/request">${csrfInput(csrf)}<input type="hidden" name="profileId" value="${html(id)}">${back}<button class="sm" type="submit">${PLUS_ICON}Connect</button></form>`
  if (connect.state === 'invite') return '<a class="button sec sm" href="/invites">Invite to Unlinked</a>'
  return ''
}
// The optional note sits under the buttons and submits with the Connect form.
const connectNote = who => `<details class="connect-note"><summary>Add a note</summary><label for="connect-note">A short note for ${html(who)} <span class="small">(optional, up to 300 characters)</span></label><textarea id="connect-note" name="note" form="connect-form" rows="3" maxlength="300"></textarea><button class="sm" type="submit" form="connect-form">Send with note</button></details>`
const PLUS_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

export function renderPerson({ accountLabel, displayName, csrf, importJob, profile = {}, connect, connectNotice, connectionQuery = '', connectionSort = 'detail', connectionsView = false, privateContext = false } = {}) {
  const connections = list(profile.connections), id = raw(profile.id), tone = hue(id || profile.name)
  const connectionPath = `/people/${encodeURIComponent(id)}/connections`
  const connectionParams = new URLSearchParams({ q: connectionQuery, sort: connectionSort })
  const more = typeof profile.nextConnectionsCursor === 'string' && profile.nextConnectionsCursor ? `${connectionPath}?${connectionParams}&cursor=${encodeURIComponent(profile.nextConnectionsCursor)}` : null
  const total = Number.isSafeInteger(profile.connectionCount) ? profile.connectionCount : null
  const known = total ? `${count(total)} ${total === 1 ? 'connection' : 'connections'}` : connections.length ? `${count(connections.length)}${more ? '+' : ''} ${connections.length === 1 && !more ? 'connection' : 'connections'}` : ''
  const basicNote = (profile.detailLevel ?? profileDetailLevel(profile)) === 'basic' ? `<p class="small depth-note">${BASIC_PAGE_ICON} Basic profile · Additional details haven’t been listed yet.</p>` : ''
  const shadowNote = profile.presence === 'shadow' ? `<p class="small shadow-note">${shadowBadge(profile, { withCount: false })} · Imported profile. Is this you? <a href="${csrf ? '/find-me' : '/join'}">Claim it</a></p>` : ''
  const facts = [raw(profile.location), raw(profile.industry), known].filter(Boolean).join(' · ')
  const owner = firstName(profile.name)
  const openChatContext = unlinkedProfileContext(profile.id)
  if (connectionsView) return renderProfileConnections({ accountLabel, displayName, csrf, importJob, profile, query: connectionQuery, sort: connectionSort, more })
  return base(raw(profile.name) || 'Profile', `<section class="profile"><div><div class="card phead"><div class="banner tone-${HUES.indexOf(tone)}"></div>${profileFace(profile, ` tone-${HUES.indexOf(tone)}`)}<h1>${html(profile.name)}</h1>${profile.headline ? `<p class="hl">${html(profile.headline)}</p>` : ''}${facts ? `<span class="small">${html(facts)}</span>` : ''}${profile.company ? `<p class="small">${companyLink(profile.company)}</p>` : ''}${profileLinks(profile)}${basicNote}${shadowNote}${profile.presence === 'member' ? '<p class="small membership-member">On Unlinked</p>' : ''}${connect?.state === 'incoming' ? `<p class="notice invite-note">${html(owner || 'They')} ${owner ? 'wants' : 'want'} to connect with you.${connect.note ? ` <q>${html(connect.note)}</q>` : ''}</p>` : ''}${Object.hasOwn(CONNECT_NOTICES, raw(connectNotice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[connectNotice])}</p>` : ''}<div class="actions">${connectControl({ connect, csrf, id, name: profile.name })}${profile.presence === 'shadow' ? (connect?.state === 'invite' ? '' : '<a class="button sec sm" href="/invites">Invite to Unlinked</a>') : openChatAction(openChatContext)}${csrf || connect ? '' : '<a class="button sm" href="/join">Join Unlinked</a>'}<a class="button sec sm" href="${csrf ? '/network' : '/people'}">Search everyone</a></div>${openChatNote(openChatContext)}${connect?.state === 'none' ? connectNote(firstName(profile.name) || 'them') : ''}</div>${privateContext && csrf && id ? privateContextMount(`/api/private-context/people/${encodeURIComponent(id)}`, profile.name) : ''}${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, 'Not listed.')}${education(profile.education)}${skills(profile.skills)}</div><aside><div class="card sec"><h3>${owner ? `${html(owner)}’s connections` : 'Connections'}${total ? ` · ${count(total)}` : connections.length ? ` · ${count(connections.length)}${more ? '+' : ''}` : ''}</h3><p class="small"><a href="${html(connectionPath)}">Browse all connections →</a></p>${connections.length ? connections.map(connectionRow).join('') : '<p class="small">None listed yet.</p>'}${more ? `<p><a href="${html(more)}">Show more</a></p>` : ''}</div></aside></section>`, { accountLabel, displayName, csrf, importJob })
}

// One of the owner's own imported contacts (not published, or not linked to a
// published profile): what their import says, and their private context.
export function renderContactDetail({ accountLabel, displayName, csrf, importJob, contact = {}, contextUrl = null } = {}) {
  const linkedin = externalProfile(contact.linkedinUrl)
  return base(raw(contact.name) || 'Contact', `<section class="profile contact-detail"><div><p class="small"><a href="/network">← Your people</a></p><div class="card phead"><div class="banner tone-${HUES.indexOf(hue(contact.name))}"></div><div class="pav tone-${HUES.indexOf(hue(contact.name))}">${html(initials(contact.name)) || '·'}</div><h1>${html(contact.name) || 'Unnamed connection'}</h1>${subline(contact) ? `<p class="hl">${html(subline(contact))}</p>` : ''}<p class="small">From your LinkedIn import · private to you${Number.isFinite(new Date(contact.connectedAt ?? NaN).getTime()) ? ` · connected ${html(new Date(contact.connectedAt).toISOString().slice(0, 10))}` : ''}</p><div class="actions">${contact.id ? `<a class="button sec sm" href="${memberHref(contact)}">View their Unlinked profile</a>` : ''}${linkedin ? `<a class="button sec sm" href="${html(linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a>` : ''}</div></div>${contextUrl ? privateContextMount(contextUrl, contact.name) : ''}</div></section>`, { accountLabel, displayName, csrf, importJob })
}

// A company page, readable with or without a session: reviewed facts when we
// have them, and everyone on Unlinked whose profile ties them to the company.
// Company facts may include the free People Data Labs company dataset, which is
// CC BY 4.0 and requires attribution wherever the facts are shown.
export const COMPANY_DATA_CREDIT = '<p class="small">Company details may include data from <a href="https://www.peopledatalabs.com/company-dataset" target="_blank" rel="noopener noreferrer nofollow">People Data Labs</a>, licensed <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer nofollow">CC BY 4.0</a>.</p>'

export function renderProfileConnections({ accountLabel, displayName, csrf, importJob, profile, query = '', sort = 'detail', more }) {
  const path = `/people/${encodeURIComponent(profile.id)}/connections`
  const total = profile.connectionsTotal ?? profile.connections.length
  return base(`${profile.name}’s connections`, `<section class="dir"><p class="small"><a href="${memberHref(profile)}">← ${html(profile.name)}’s profile</a></p><h1 class="hq">${html(profile.name)}’s connections</h1><p class="small">${count(total)} ${query ? 'matching' : 'listed'} connections · ${BASIC_PAGE_ICON} indicates a basic profile with no additional details yet.</p><form class="connection-filters" method="get" action="${html(path)}" role="search"><label>Search connections<input type="search" name="q" maxlength="200" value="${html(query)}" placeholder="Name, role or company"></label><label>Order<select name="sort"><option value="detail"${sort === 'detail' ? ' selected' : ''}>More detail first</option><option value="name"${sort === 'name' ? ' selected' : ''}>Name A–Z</option></select></label><button type="submit">Apply</button>${query ? `<a href="${html(path)}">Clear search</a>` : ''}</form>${profile.connections.length ? `<div class="panel list">${profile.connections.map(member).join('')}</div>` : `<p class="notice">${query ? 'No connections match this search.' : 'No public connections listed yet.'}</p>`}${more ? `<p><a class="button sec" href="${html(more)}">Show more connections</a></p>` : ''}<p class="small">Only connections already shared on Unlinked are shown.</p></section>`, { accountLabel, displayName, csrf, importJob })
}

export function renderCompany({ accountLabel, displayName, csrf, importJob, name, facts = null, people = [], total = 0, nextCursor } = {}) {
  const title = raw(facts?.name).trim() || raw(name).trim()
  const tone = hue(title)
  const factLine = [raw(facts?.industry), facts?.employeeCount ? `${count(facts.employeeCount)} employees on LinkedIn` : '', raw(facts?.headquarters), facts?.founded ? `Founded ${raw(facts.founded)}` : ''].filter(Boolean).join(' · ')
  const rows = list(people)
  const links = [facts?.website && companySite(facts.website) ? `<a href="${html(companySite(facts.website))}" target="_blank" rel="noopener noreferrer nofollow">Website ↗</a>` : '',
    facts?.linkedinUrl && externalCompany(facts.linkedinUrl) ? `<a href="${html(externalCompany(facts.linkedinUrl))}" target="_blank" rel="noopener noreferrer">LinkedIn page ↗</a>` : ''].filter(Boolean)
  const more = typeof nextCursor === 'string' && nextCursor ? `/companies/${encodeURIComponent(raw(name).trim())}?cursor=${encodeURIComponent(nextCursor)}` : null
  return base(title || 'Company', `<section class="profile"><div><div class="card phead"><div class="banner tone-${HUES.indexOf(tone)}"></div><div class="pav tone-${HUES.indexOf(tone)}">${html(initials(title))}</div><h1>${html(title)}</h1>${companyDetailLevel(facts) === 'basic' ? `<p class="small depth-note">${BASIC_PAGE_ICON} Basic company page · Company details haven’t been listed yet.</p>` : ''}${facts?.tagline ? `<p class="hl">${html(facts.tagline)}</p>` : ''}${factLine ? `<span class="small">${html(factLine)}</span>` : ''}${links.length ? `<p class="small profile-links">${links.join(' · ')}</p>` : ''}<div class="actions">${csrf ? '' : '<a class="button sm" href="/join">Join Unlinked</a>'}<a class="button sec sm" href="${csrf ? '/network' : '/people'}">Search everyone</a></div></div>${facts?.description ? `<div class="card sec"><h3>About</h3><p>${html(facts.description)}</p></div>` : ''}${facts ? COMPANY_DATA_CREDIT : ''}</div><aside><div class="card sec"><h3>On Unlinked${total ? ` · ${count(total)}` : ''}</h3>${rows.length ? rows.map(connectionRow).join('') : '<p class="small">No one on Unlinked lists this company yet.</p>'}${more ? `<p><a href="${html(more)}">Show more</a></p>` : ''}</div></aside></section>`, { accountLabel, displayName, csrf, importJob })
}
const companySite = value => { try { const url = new URL(raw(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null } }
const externalCompany = value => { try { const url = new URL(raw(value)); return url.protocol === 'https:' && ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) && !url.username && !url.password ? url.href : null } catch { return null } }

export function renderPeople({ accountLabel, displayName, csrf, query = '', mode = 'best', presence, sort = 'best', total, added = false, match, everyone, own, contacts, searchResults, aiMatches, aiNote, aiError, anonymousAi = false, nextCursor, nextContactPage, state = 'ready', importJob, publicProfessionalSearch, connectedCounts, connectedView, scope, returnTo = '/network', notice }) {
  const exact = mode === 'exact', kept = presence === 'member' || presence === 'shadow' ? presence : undefined
  const controls = value => {
    const context = unlinkedProfileContext(value.id)
    const message = value.presence === 'member' && context && value.connect?.state !== 'self' ? openChatAction(context) : ''
    const invite = value.presence === 'shadow' && value.connect?.state !== 'invite' ? '<a class="button sec sm" href="/invites">Invite to Unlinked</a>' : ''
    const connection = connectControl({ connect: value.connect, csrf, id: value.id, name: value.name, next: returnTo, row: true })
    return message || invite || connection ? `<div class="connection-actions">${message}${invite}${connection}</div>` : ''
  }
  const row = (value, render) => {
    const at = sort === 'connected' ? value.connectedAt : sort === 'imported' ? value.importedAt : undefined
    const date = Number.isSafeInteger(at) && at > 0 && at <= 8640000000000000 ? new Date(at).toISOString().slice(0, 10) : null
    const dateLabel = ['connected', 'imported'].includes(sort) ? `<p class="small network-date">${sort === 'connected' ? 'Connected' : 'Imported'} ${date ? `<time datetime="${date}">${date}</time>` : 'date unknown'}</p>` : ''
    return render(value).replace('<article ', `<article ${typeof value.sourceRowId === 'string' ? `data-network-row="${html(value.sourceRowId)}" ` : ''}`).replace('</div></article>', `${dateLabel}${controls(value)}</div></article>`)
  }
  const filters = [kept ? `presence=${kept}` : '', connectedView ? 'connected=1' : '', sort !== 'best' ? `sort=${sort}` : ''].filter(Boolean).join('&')
  const searched = `q=${encodeURIComponent(raw(query))}${filters ? `&${filters}` : ''}`
  // Two ways to read the same words: forgiving by default, literal on request.
  const modes = raw(query) ? `<p class="small modes">${exact ? `<a href="${html(`/network?${searched}`)}">Best match</a> · <b aria-current="true">Exact words</b>` : `<b aria-current="true">Best match</b> · <a href="${html(`/network?${searched}&mode=exact`)}">Exact words</a>`} · <a href="${html(filters ? `/network?${filters}` : '/network')}">Clear search</a></p>${!exact && match === 'some' ? '<p class="notice">No one has every word. Showing people who match some of them.</p>' : ''}` : ''
  const legacy = own === undefined && (contacts !== undefined || searchResults !== undefined)
  const canSearchEveryone = publicProfessionalSearch ?? (everyone !== undefined || legacy)
  if (legacy) own = list(searchResults !== undefined ? searchResults : contacts)
  const noMatch = query && (!legacy || list(contacts).length > 0)
  const ownGroup = own === undefined ? '' : `<section class="own-group" aria-label="People you know"><h2>People you know</h2>${list(own).length ? `<div class="panel list">${list(own).map(value => `${row(value, person)}${value.reason ? `<p class="reason">${html(value.reason)}</p>` : ''}`).join('')}</div>` : `<div class="notice">${noMatch ? 'No people matched. Try another name or company.' : 'Bring your LinkedIn export to see your people.'} <a href="/import">Add a file →</a></div>`}</section>`
  // Who to show: everyone, people who joined, or imported profiles not on Unlinked yet.
  const filterHref = value => `/network${[raw(query) ? `q=${encodeURIComponent(raw(query))}` : '', exact ? 'mode=exact' : '', connectedView ? 'connected=1' : '', sort !== 'best' ? `sort=${sort}` : '', value ? `presence=${value}` : ''].filter(Boolean).reduce((path, part, index) => `${path}${index ? '&' : '?'}${part}`, '')}`
  const contactMore = nextContactPage !== undefined ? `<p><a href="${html(`${filterHref(kept)}${filterHref(kept).includes('?') ? '&' : '?'}page=${nextContactPage}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`)}">Next contacts</a></p>` : ''
  const presenceFilter = `<nav class="network-segments" aria-label="Membership status">${PRESENCE_FILTERS.map(([value, label]) => `<a href="${html(filterHref(value))}"${value === kept ? ' aria-current="true"' : ''}>${label}</a>`).join('')}</nav>`
  const scopeHref = connected => {
    const params = new URLSearchParams()
    if (raw(query)) params.set('q', raw(query))
    if (exact) params.set('mode', 'exact')
    if (kept) params.set('presence', kept)
    if (connected) params.set('connected', '1')
    if (sort !== 'best' && (connected || !['connected', 'imported'].includes(sort))) params.set('sort', sort)
    return `/network${params.size ? `?${params}` : ''}`
  }
  const selectedSort = sort
  const options = [['best', raw(query) ? 'Best match' : 'Default order'], ['name', 'Name (A–Z)'], ['name-desc', 'Name (Z–A)'], ...(connectedView ? [['connected', 'Recently connected'], ['imported', 'Recently imported']] : [])]
  const toolbar = `<div class="network-toolbar">${connectedCounts ? `<nav class="network-scopes" aria-label="People to show"><a href="${html(scopeHref(false))}"${!connectedView ? ' aria-current="true"' : ''}>Everyone</a><a href="${html(scopeHref(true))}"${connectedView ? ' aria-current="true"' : ''}>My connections <span>${count(connectedCounts.all)}</span></a></nav>` : ''}<form id="network-filters" method="get" action="/network" role="search" aria-label="Filter current list">${kept ? `<input type="hidden" name="presence" value="${kept}">` : ''}${connectedView ? '<input type="hidden" name="connected" value="1">' : ''}${exact ? '<input type="hidden" name="mode" value="exact">' : ''}<div class="network-fields"><label class="network-query" for="network-query">${connectedView ? 'Filter my connections' : 'Filter people'}<input id="network-query" name="q" type="search" maxlength="200" placeholder="Name, company, role, or keyword" value="${html(query)}" autocomplete="off" enterkeyhint="search" aria-describedby="network-search-help"></label><label class="network-sort" for="network-sort">Sort by<select id="network-sort" name="sort">${options.map(([value, label]) => `<option value="${value}"${value === selectedSort ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button class="network-apply sec" type="submit">Apply</button></div><p id="network-search-help" class="small">Filter this list by name, company, role, or keyword.</p></form><div class="network-filter-row"><span class="small">Membership</span>${presenceFilter}${query || kept || sort !== 'best' ? `<a class="network-reset" href="${connectedView ? '/network?connected=1' : '/network'}">Clear filters</a>` : ''}</div></div>`
  // Every card on the page counts once: people you know plus everyone else.
  const visibleCount = connectedView ? list(connectedView.rows).length : list(everyone).length + (everyone !== undefined && own !== undefined && !legacy ? list(own).length : 0)
  const resultCount = connectedView?.total ?? total
  const summary = `<p class="network-count small" role="status" aria-live="polite">${Number.isSafeInteger(resultCount) ? `Showing ${count(visibleCount)} of ${count(resultCount)} ${query || kept ? 'matching ' : ''}${connectedView ? 'connections' : 'people'}` : ''}</p>`
  const dateNote = sort === 'connected' ? '<p class="small">Newest connection dates first, from LinkedIn or accepted Unlinked connections. Unknown dates appear last.</p>' : sort === 'imported' ? '<p class="small">Most recently imported first. This is when you brought people into Unlinked, not when you first connected. Unknown dates appear last.</p>' : ''
  const everyoneTitle = kept === 'member' ? 'On Unlinked' : kept === 'shadow' ? 'Not yet on Unlinked' : 'Everyone on Unlinked'
  const emptyEveryone = kept === 'member' ? `${query ? 'No one who joined matches that yet.' : 'No one has joined yet.'} Most profiles here were imported from LinkedIn connections.` : query ? 'No one on Unlinked matched that yet.' : 'No members to show yet.'
  const everyoneGroup = everyone === undefined ? '' : `<section class="everyone-group" aria-label="${everyoneTitle}"><h2>${everyoneTitle}</h2>${state === 'unavailable' ? '<p class="notice" role="status">Searching everyone on Unlinked did not finish this time. <a href="">Try again</a></p>' : list(everyone).length ? `<div class="panel list">${list(everyone).map(value => row(value, member)).join('')}</div>` : `<p class="notice">${emptyEveryone}</p>`}</section>`
  const more = typeof nextCursor === 'string' && nextCursor ? `<p><a class="button sec sm" href="${html(`${filterHref(kept)}${filterHref(kept).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(nextCursor)}`)}">Show more</a></p>` : ''
  // The same words, ranked by AI. A button on the results, not a second search box.
  const scopes = csrf && raw(query) ? [canSearchEveryone ? ['everyone', 'everyone'] : null, own !== undefined ? ['own', 'my people'] : null].filter(Boolean) : []
  // A visitor gets the same AI ranking over the public list; it carries no session authority.
  const askAi = scopes.length ? `<form class="ask-ai actions" method="post" action="/search-account">${csrfInput(csrf)}<input type="hidden" name="query" value="${html(query)}"><span class="small">Looking for something less literal?</span>${scopes.map(([value, label]) => `<button class="quiet sm" type="submit" name="scope" value="${value}">Ask AI across ${label}</button>`).join('')}</form>`
    : !csrf && anonymousAi && raw(query) ? `<form class="ask-ai actions" method="post" action="/ask"><input type="hidden" name="query" value="${html(query)}"><span class="small">Looking for something less literal?</span><button class="quiet sm" type="submit">Ask AI</button></form>` : ''
  // AI picks carry the model's reason; plain list rows never do.
  const aiGroup = aiMatches === undefined && !aiError ? '' : aiError ? `<section class="ai-group" aria-label="AI picks"><h2>AI picks</h2><p class="notice error" role="alert">${html(aiError)}</p></section>` : `<section class="ai-group" aria-label="AI picks"><h2>AI picks</h2>${list(aiMatches).length ? `<div class="panel list">${list(aiMatches).map(value => `${row(value, member)}${value.reason ? `<p class="reason">${html(value.reason)}</p>` : ''}`).join('')}</div>` : '<p class="notice">The AI found no one who fits. Try other words.</p>'}<p class="small">${aiNote ? `${html(aiNote)} ` : ''}OpenAI received your words and a limited set of public names, headlines and roles.</p></section>`
  return base('People', `<section class="dir" data-network><h1 class="hq">${raw(query) ? `Results for “${html(query)}”` : 'People'}</h1>${toolbar}<div data-network-results>${summary}${dateNote}${modes}${Object.hasOwn(CONNECT_NOTICES, raw(notice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[notice])}</p>` : ''}${raw(query) ? '' : `<p class="lead">${state === 'welcome' ? "You're in. " : ''}${own === undefined ? 'People on Unlinked, ready to search.' : 'The people you know, ready to search.'}</p>`}${added ? '<p class="notice" role="status">Added to your people. They appear here once processed, usually within a minute.</p>' : ''}${askAi}${state === 'error' ? '<p class="notice error" role="alert">We could not read your people right now. Try again; this does not mean your network is empty.</p>' : `${connectedView ? `<section aria-label="My connections"><h2>${kept === 'member' ? 'My connections on Unlinked' : 'My connections'} · ${count(connectedView.total)}</h2>${state === 'unavailable' ? '<p class="notice">Connections could not be read. Try again.</p>' : list(connectedView.rows).length ? `<div class="panel list">${connectedView.rows.map(value => row(value, member)).join('')}</div>` : '<p class="notice">No connections match this filter.</p>'}${connectedView.nextPage !== undefined ? `<a href="${html(`${filterHref(kept)}${filterHref(kept).includes('?') ? '&' : '?'}page=${connectedView.nextPage}`)}">Show more</a>` : ''}</section>` : `${aiGroup}${ownGroup}${contactMore}${everyoneGroup}${more}`}`}</div><p class="small">${csrf ? '<a href="/people/add">Add a person</a> · <a href="/invites">Invite someone</a> · ' : ''}Friends come soon.</p></section>`, { accountLabel, displayName, csrf, importJob, query, mode, presence: kept, sort, connected: Boolean(connectedView), network: true })
}

// Settings' email section, only while email is on. The member's own address is the only one shown.
const emailSection = email => {
  if (!email) return ''
  const choices = Object.entries(email.labels ?? {}).map(([kind, label]) => `<label><input type="checkbox" name="kinds" value="${html(kind)}"${email.preferences?.[kind] ? ' checked' : ''}> ${html(label)}</label>`).join('')
  return `<h2 id="email">Email</h2><div class="card">${email.saved ? '<p class="notice" role="status">Email settings saved.</p>' : ''}${email.address ? `<p>Emails go to <b>${html(email.address)}</b>, the address you sign in with.</p>` : '<p class="notice">We do not have a verified email address for your account yet, so we send you no email. Sign out and sign in again to add the one you sign in with.</p>'}<form method="post" action="/settings/email">${csrfInput(email.csrf)}${choices}<button class="quiet" type="submit">Save email settings</button></form><p class="small">At most one email every 15 minutes; several updates arrive together. Anything you already saw on Unlinked is not emailed. Every email has a one-click unsubscribe link.</p></div>`
}

export function renderSettings({ accountLabel, displayName, csrf, publicProfessionalSearch = false, imports = [], grants = [], agentConfiguration, agentSetups, selectedKeyId, keyManagement = false, connector, importJob, deleteError, agentAccess, connectionActionsAvailable = false, email }) {
  const sharedConnector = '<section class="card sec"><h3>Connect across Ideaflow apps</h3><p>For compatible hosts that need multiple apps, use the shared Ideaflow sign-in connector. Choose Unlinked and OpenChat permissions there; sending messages needs separate OpenChat write permission. Existing direct Unlinked connections keep working.</p><a class="button" href="https://id.ideaflow.app/agents">Open Ideaflow connector setup</a></section>'
  const connections = list(grants).filter(value => value?.connection), manualGrants = list(grants).filter(value => !value?.connection)
  const selected = selectedKeyId === undefined ? manualGrants[0] : manualGrants.find(value => value.id === selectedKeyId)
  const selectionUnavailable = selectedKeyId !== undefined && !selected
  if (selectionUnavailable) { agentConfiguration = null; agentSetups = null; agentAccess = undefined }
  const serialized = typeof agentConfiguration === 'string' ? agentConfiguration : agentConfiguration ? JSON.stringify(agentConfiguration, null, 2) : null
  const keyForm = (action, content) => `<form method="post" action="/settings/api-keys">${csrfInput(csrf)}<input type="hidden" name="action" value="${action}"><input type="hidden" name="grantId" value="${html(selected?.id)}">${content}</form>`
  const manual = `<section id="api-keys"><h3>API keys</h3><p>For Muse, config files and apps that ask for a key. Each key works until you revoke it.</p>
    ${manualGrants.length ? `<nav class="key-list" aria-label="Your API keys">${manualGrants.map(value => `<a class="key-row" href="/settings?key=${encodeURIComponent(value.id)}#api-keys"${value.id === selected?.id ? ' aria-current="true"' : ''}><b>${html(value.name ?? 'Existing key')}</b><span class="small">${html(day(value.issuedAt))} · ${html(value.id.slice(0, 8))}</span></a>`).join('')}</nav>` : ''}
    ${serialized ? `<div class="selected-key"><h4>${html(selected?.name ?? 'Default key')}</h4><p class="small">Access: ${html(scopeLabel(agentAccess?.scope))}. Until revoked.</p>
      ${!agentSetups ? '<button type="button" class="quiet" data-copy-target="onboarding-agent-configuration" data-copy-help="onboarding-copy-help">Copy agent setup</button>' : ''}${agentSetups ? `<label for="agent-setup-token">API key</label><div class="key-value"><input id="agent-setup-token" type="password" readonly autocomplete="off" spellcheck="false" value="${html(agentSetups.accessToken)}"><button type="button" class="quiet" data-reveal-target="agent-setup-token" aria-controls="agent-setup-token" aria-pressed="false">Show</button></div><div class="actions"><button type="button" data-copy-target="agent-setup-token" data-copy-help="agent-key-copy-help">Copy API key</button><button id="onboarding-copy-agent" type="button" class="quiet" data-copy-target="onboarding-agent-configuration" data-copy-help="agent-key-copy-help">Copy agent setup</button></div><p id="agent-key-copy-help" class="small" role="status">You can show and copy this key anytime while signed in. Copying does not replace it.</p><p class="small"><b>Copy API key</b> copies only the key. <b>Copy agent setup</b> copies the MCP configuration for clients such as Cursor.</p>` : ''}
      ${keyManagement && selected ? `<section class="key-permissions" aria-labelledby="key-permissions-title"><h4 id="key-permissions-title">Permissions for this key</h4>${keyForm('permissions', `${connectionActionsAvailable || scopeAllowsConnectionActions(agentAccess?.scope) ? `<label for="key-connection-actions"><input id="key-connection-actions" type="checkbox" role="switch" name="access" value="connections"${scopeAllowsConnectionActions(agentAccess?.scope) ? ' checked' : ''}> Send and manage connection requests</label><p class="small">${scopeAllowsConnectionActions(agentAccess?.scope) ? 'On' : 'Off'} · Send, accept, ignore and withdraw Unlinked connection requests. This does not send messages or record private relationships.</p>` : ''}<label for="key-private-notes"><input id="key-private-notes" type="checkbox" role="switch" name="private_notes" value="on"${scopeAllowsPrivateNotes(agentAccess?.scope) ? ' checked' : ''}> Private people notes &amp; relations</label><p class="small">${scopeAllowsPrivateNotes(agentAccess?.scope) ? 'On' : 'Off'} · Read and write your private notes and relations about people (“X knows Y”). Only you see them, in Unlinked and OpenChat; each agent-written note is labelled with this key’s name. Never notifies anyone, never sends a connection request or a message.</p><button class="quiet">Save permissions</button>`)}<p class="small">Turn these on or off without replacing or reconnecting the key. Other keys and signed-in apps are unchanged. Messaging is not part of Unlinked keys: it is OpenChat, through the <a href="/agents">shared Ideaflow connector</a>.</p></section>` : ''}
      <p class="small">New tools within enabled permissions use this same key. If your agent caches its tool list, refresh that list; do not replace the key.</p>
      <details><summary>Setup instructions and advanced formats</summary><p><b>Muse:</b> ask it to add a custom API connector using <code>https://www.unlinked.ai/openapi.json</code>. If its credential form asks for an API key or access token, paste <b>Copy API key</b> without quotes, JSON or a Bearer prefix. For a full Authorization header value, use <code>Bearer </code> followed by the key. Muse OAuth has not been verified.</p>${agentClientSections(agentSetups, serialized, Boolean(connector))}</details>
      ${!keyManagement && selected ? `<form method="post" action="/revoke-account">${csrfInput(csrf)}<input type="hidden" name="grantId" value="${html(selected.id)}"><button class="quiet">Revoke access</button></form>` : ''}${keyManagement && selected ? `<details><summary>Manage ${html(selected.name ?? 'this key')}</summary>${keyForm('rename', `<label for="key-name">Key name</label><input id="key-name" type="text" name="name" maxlength="80" required value="${html(selected.name ?? 'Existing key')}"><button class="quiet">Save name</button>`)}<p>Replacing this key invalidates its old secret and stops clients using it. Other keys and connected apps stay connected. Permissions stay the same.</p>${keyForm('replace', '<button class="quiet">Replace this key</button>')}<p>Revoking stops this key. You can create a new one later.</p>${keyForm('revoke', '<button class="danger">Revoke this key</button>')}</details>` : ''}</div>` : selectionUnavailable ? '<p class="notice" role="status">This API key is no longer available. <a href="/settings#api-keys">Refresh API keys</a> or select another key.</p>' : '<p class="notice">No API key is prepared. Create one when you want to connect an app.</p>'}
    <details${serialized ? '' : ' open'}><summary>Create API key</summary><form method="post" action="${keyManagement ? '/settings/api-keys' : '/setup-account'}">${csrfInput(csrf)}${keyManagement ? '<input type="hidden" name="action" value="create"><label for="new-key-name">Key name</label><input id="new-key-name" type="text" name="name" maxlength="80" required placeholder="For example, Muse">' : ''}<p class="small">Read access to ${publicProfessionalSearch ? 'your network and People' : 'your network'}. No import required to connect.</p>${keyManagement ? '<label><input type="checkbox" name="private_notes" value="on" checked> Private people notes &amp; relations (on by default; only you see them)</label>' : ''}${connectionActionsAvailable ? '<label><input type="checkbox" name="access" value="connections"> Send and manage connection requests (optional)</label>' : ''}<button>Create API key</button></form></details>
    <p class="small">Keep keys private. A successful request from your app confirms it is connected.</p></section>`
  const agentCard = `${manual}${connector ? `<section aria-label="Connect with sign-in"><h3>Connect with sign-in</h3>${connectorSection(connector, connections, csrf)}</section>` : ''}`
  return base('Settings', `<section class="narrow wide"><h1 class="hq">Settings</h1><div class="acct"><span>Signed in as <b>${html(accountLabel)}</b></span><form method="post" action="/logout">${csrfInput(csrf)}<button class="quiet sm" type="submit" title="Ends this session on this device. Your profile, files and agent access stay.">Sign out</button></form></div><h2>Your agent</h2><div class="card">${agentCard}<p class="small"><a href="/agents">How agents connect and what to upload</a></p></div>${sharedConnector}${emailSection(email && { ...email, csrf })}<h2>Privacy</h2><div class="card"><p>${publicProfessionalSearch ? 'Your original file and contact details stay private. New imports make professional profiles and connections findable by members and visitors; earlier private imports remain private.' : 'Your file, profile and connections stay private to your account.'} When you or an agent you connect searches, OpenAI receives the search query and a limited set of relevant names, companies, roles and connection dates. Contact email addresses and phone numbers are never sent.</p><p>Your own phone number and other contact details appear only on your contact card, for people you give its link to. <a href="/card?share=contact">Manage my contact card</a></p></div><h2>Your files</h2><div class="card">${list(imports).map(value => `<details><summary>${html(value.filename)} · import details</summary><p>${count(value.accepted)} records accepted · ${count(value.indexed)} indexed${value.status === 'partial' && value.rejected ? ` · ${count(value.rejected)} ${value.rejected === 1 ? 'row' : 'rows'} skipped` : ''}.</p><p>${value.status === 'partial' && value.rejected && !value.failedFiles ? 'finished · rows with no name or LinkedIn address were skipped' : html(value.status)}</p>${value.errorMessage ? `<p class="notice error">${html(value.errorMessage)}</p>` : ''}<p>Professional profiles and connections: ${value.visibility === 'public' ? 'public' : 'private'}.</p>${value.sha256 ? `<p>SHA-256: <code>${html(value.sha256)}</code></p>` : ''}${/^[a-zA-Z0-9_-]+$/.test(raw(value.id)) ? `<a href="/imports/${encodeURIComponent(raw(value.id))}">View technical details</a>` : ''}</details>`).join('') || '<p>No files added yet.</p>'}<p><a href="/import">Add a file →</a></p></div><h2>Your data</h2><div class="card"><p>Your profile, connections and files belong to you. Take a full copy, or erase everything, whenever you want.</p><form method="get" action="/export"><button class="quiet" type="submit">Download everything (JSON)</button></form><p class="small">One file with your profile, every import and the people in it, recovered legacy records, your agent grants, and the private notes and relations you keep about people.</p><details${deleteError ? ' open' : ''}><summary>Delete everything…</summary><p>This permanently erases your imports, profile, connections, receipts and agent access, and removes you from the public People index. There is no undo. You can sign in again later, but you start from nothing.</p><p class="small">Private notes and relations about people belong to your Ideaflow account and are shared with OpenChat, so they are kept. Delete them in OpenChat or ask your agent to.</p>${deleteError ? `<p class="notice error" role="alert">${html(deleteError)}</p>` : ''}<form method="post" action="/delete-account">${csrfInput(csrf)}<label for="delete-confirm">Type <b>delete everything</b> to confirm</label><input id="delete-confirm" type="text" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="delete everything"><button class="danger" type="submit">Permanently delete my data</button></form></details></div></section>`, { accountLabel, displayName, csrf, importJob })
}

// An email's unsubscribe link: confirm (GET), done or invalid (POST). Works signed out.
export function renderEmailUnsubscribe({ accountLabel, displayName, csrf, importJob, state, token, scope, kinds = [] } = {}) {
  const what = scope === 'address' ? 'invite emails from Unlinked' : list(kinds).length > 1 ? 'these Unlinked emails' : 'emails like this one'
  const content = state === 'done'
    ? `<h1 class="hq">You are unsubscribed</h1><p class="lead">You will not get ${html(what)} again.</p>${scope === 'member' ? '<p>Choose which emails you get in <a href="/settings#email">Settings</a>.</p>' : ''}`
    : state === 'confirm'
      ? `<h1 class="hq">Unsubscribe</h1><p class="lead">Stop ${html(what)}?</p><form method="post" action="/email/unsubscribe"><input type="hidden" name="t" value="${html(token)}"><button type="submit">Unsubscribe</button></form>${scope === 'member' ? '<p class="small">You can also choose which emails you get in <a href="/settings#email">Settings</a>.</p>' : ''}`
      : `<h1 class="hq">This link does not work</h1><p class="lead">It is incomplete or has expired.</p><p>Members can turn emails off in <a href="/settings#email">Settings</a>.</p>`
  return base('Unsubscribe', `<section class="narrow">${content}</section>`, csrf ? { accountLabel, displayName, csrf, importJob } : {})
}

// Shown once, right after an account's data has been erased. No session remains.
export function renderDataDeleted() {
  return base('Your data is deleted', `<section class="narrow"><h1 class="hq">Your data is deleted</h1><p class="lead">Your imports, profile, connections and agent access have been erased, and you no longer appear in the public People index.</p><p>If you ever want to come back, sign in again and bring a fresh LinkedIn export.</p><p><a class="button" href="/">Back to the home page</a></p></section>`)
}

// The public People index could not be read: say so in a page, never raw JSON.
export function renderPeopleUnavailable({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('People are unavailable', `<section class="narrow"><h1 class="hq">People are unavailable right now</h1><p class="lead">We could not load profiles on Unlinked this time. Nothing about your account or files has changed.</p><p><a class="button" href="">Try again</a> <a class="button sec" href="${csrf ? '/network' : '/'}">${csrf ? 'Back to your people' : 'Back to the home page'}</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

// Public guides, readable with or without a session.
export function renderAgents({ accountLabel, displayName, csrf, importJob } = {}) {
  const setupLink = csrf
    ? '<a class="button" href="/settings#api-keys">Open API keys in Settings</a>'
    : '<a class="button" href="/login?next=%2Fsettings">Sign in to open API keys</a>'
  const setup = `<div class="card sec" aria-labelledby="agent-setup-heading"><h2 id="agent-setup-heading">Set up your agent</h2><p>${csrf ? 'Your API key and agent setup are in Settings.' : 'Sign in to get your API key and agent setup in Settings.'}</p><p>Choose <b>Copy API key</b> for Muse or an app that asks for a key. Choose <b>Copy agent setup</b> for an MCP configuration. You can return to Settings and copy again anytime.</p><div class="actions">${setupLink}<a class="button quiet" href="#connect-with-sign-in">Connect Claude or ChatGPT</a></div></div>`
  return base('Unlinked for AI agents', `<section class="narrow wide"><h1 class="hq">Unlinked for AI agents</h1>${setup}<div class="card sec"><h3>One connector for your Ideaflow apps</h3><p>Use one connection for Unlinked, OpenChat and Thoughtstream Vision, with separate read and write permissions for each app.</p><a class="button" href="https://id.ideaflow.app/agents">Connect an agent</a><p><code>https://id.ideaflow.app/mcp</code></p></div><p class="small"><a href="https://id.ideaflow.app/agents">Shared Ideaflow agent setup →</a></p><p class="lead">Unlinked is meant to be used by agents as much as by people. An agent you connect can search your people and everyone on Unlinked.</p><div class="card sec" id="connect-with-sign-in"><h3>Unlinked-only connection (optional)</h3><pre>https://www.unlinked.ai/mcp</pre><p>In Claude (claude.ai, Desktop or mobile) choose <b>Settings → Connectors → Add custom connector</b>, paste this address, choose <b>Connect</b>, sign in to Unlinked and choose <b>Allow</b>. ChatGPT developer-mode connectors and Claude Code (<code>claude mcp add --transport http unlinked https://www.unlinked.ai/mcp</code>) sign in the same way.</p><p class="small">For Muse or an app that asks for a key, open <b>Settings → API keys → Copy API key</b>. Paste only the key into its API-key/access-token field, without a Bearer prefix or JSON. Muse can use a custom API connector with <code>https://www.unlinked.ai/openapi.json</code>; Muse OAuth is unverified. <b>Copy agent setup</b> still copies the selected key’s MCP configuration for compatible clients. Show/Hide and copy work again anytime, without replacing the key. Create named independent keys and manage each separately. New tools within enabled permissions use the same key. To turn connection actions on or off, select the key, use <b>Send and manage connection requests</b>, then <b>Save permissions</b>. <b>Private people notes &amp; relations</b> is a separate switch beside it, on by default. Refresh a cached tool list instead of replacing the key. Advanced formats include Claude Desktop’s <code>claude_desktop_config.json</code> (via <code>mcp-remote</code>), Cursor and other MCP clients.</p><p class="small">Each connected app and each credential accesses its permitted data until you disconnect or revoke it in Settings. Owner-only keys remain limited to your network; public-read permission also includes the published professional People index. Everyone browsing needs no sign-in or archive. The grant excludes raw archives and contact details. Keep the configuration private.</p><div class="actions">${setupLink}</div></div><div class="card sec"><h3>2. What to upload, and how</h3>${exportSteps()}<div class="row"><span>Read from the archive</span><b>Connections, Profile, Positions, Education, Skills</b></div><div class="row"><span>Also accepted</span><b>Connections.csv on its own</b></div><p class="small"><a href="/import-linkedin">Import instructions</a> · <a href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Request your LinkedIn export ↗</a></p></div><div class="card sec"><h3>3. What an agent can do</h3><div class="row"><span><code>unlinked_search_network</code></span><b>Search the person’s own connections</b></div><div class="row"><span><code>unlinked_search_everyone</code></span><b>Search every published profile on Unlinked</b></div><div class="row"><span><code>unlinked_list_notifications</code></span><b>Read the person’s notifications and pending connection requests</b></div><div class="row"><span>Send, accept, ignore or withdraw connection requests</span><b>Only with explicit opt-in in Settings or OAuth consent; off by default</b></div><div class="row"><span>Record and read private notes and relations (“X knows Y”)</span><b>Only you see them, in Unlinked and OpenChat; never notifies anyone. Separate permission, on by default; switch it off per key in Settings</b></div><div class="row"><span>Send messages or post</span><b>Separate OpenChat permissions in the shared connector; not an Unlinked key permission</b></div></div><div class="card sec"><h3>OpenChat messages and Context</h3><p>Unlinked and OpenChat share your Ideaflow account and inbox. To give your agent access to messages or conversation Context, enable OpenChat permissions in the shared Ideaflow connector. For direct API clients, the same OpenChat key works for both, with conversation membership and read/write permissions.</p><p>In OpenChat, open <b>Settings → Agent keys → New API key</b>. Existing keys can be revealed and copied again anytime. Copy agent setup creates a fresh key; copying setup from a key’s detail screen reuses that key.</p><p><a href="https://chat.globalbr.ai/agents">API keys, MCP setup, Context examples and troubleshooting</a> · <a href="https://chat.globalbr.ai/api/docs">OpenChat API reference</a> · <a href="https://chat.globalbr.ai/AGENTS.md">OpenChat agent brief</a></p><p class="small">The shared Ideaflow connector handles both apps. For direct API access, Unlinked grants and OpenChat keys remain service-specific.</p></div><div class="card sec"><h3>4. Machine-readable</h3><p>If a query fails, share its response <code>X-Request-ID</code> (when present), time and timezone, endpoint or tool, error wording, and elapsed time. Keep credentials, private query text and results private.</p><p>For public search without installing a connector, open <a href="/search-public">the compact public search page</a> and share its search link with your web assistant. It needs no sign-in or JavaScript; your private network still requires an authorized connection. An <a href="https://unlinked-ideaflowco.vercel.app/search-public">experimental alternate public search link</a> is available; ordinary ChatGPT access is not established.</p><p>The same instructions are at <a href="/llms.txt">Agent guide</a>, with the interface at <a href="/openapi.json">API description</a> and <a href="/.well-known/mcp/server-card.json">the MCP server card</a>.</p></div></section>`, { accountLabel, displayName, csrf, importJob })
}

export function renderImportGuide({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('Bring your LinkedIn export', `<section class="narrow wide"><h1 class="hq">Bring your LinkedIn export</h1><p class="lead">Request your LinkedIn data export on the LinkedIn website, then import the ZIP after signing in.</p><div class="card sec"><h3>What to request</h3><p>A complete archive can include your profile, experience, education, skills and connections. Connections-only ZIP or CSV is also supported.</p>${exportSteps()}<p><a href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Request LinkedIn export ↗</a></p></div><div class="card sec"><h3>What happens next</h3><p>Maximum archive size: 64 MiB. Processing continues on the server after you leave the page; return to Profile or People for progress. Search and agent setup use your own account’s published records.</p><div class="actions">${csrf ? '<a class="button sm" href="/import">Import my file</a>' : '<a class="button sm" href="/login?next=%2Fimport">Sign in and import</a>'}<a class="button sec sm" href="${csrf ? '/network' : '/people'}">Explore people</a></div></div></section>`, { accountLabel, displayName, csrf, importJob })
}

// The controls keep their ids; the controller attaches the scanner script with its own nonce.
// Nothing opens, and no contact or access changes, until the person presses Open.
export function renderMeet({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('Meet someone', `<section class="narrow wide"><h1 class="hq">Meet someone</h1><p class="lead">Scan an Unlinked profile card or an OpenChat card, or paste its link. You confirm what was scanned before anything opens; scanning never adds a contact or grants access by itself.</p><div class="card"><div class="actions"><button id="start" type="button">Scan a card</button><button id="stop" type="button" class="quiet">Stop camera</button></div><div id="camera"></div><div id="confirm" class="notice" hidden><p>Scanned: <b id="confirm-label"></b></p><p class="small">Open it to continue. Opening a profile only shows its public page.</p><div class="actions"><a id="confirm-open" class="button sm" href="/meet">Open</a><button id="confirm-cancel" type="button" class="quiet sm">Cancel</button></div></div><form id="paste"><label for="card-url">Card or profile link</label><input id="card-url" type="text" inputmode="url" required><div class="actions"><button class="quiet">Check link</button></div></form><p id="status" class="small" role="status"></p></div><p class="small">If the camera is unavailable or permission is declined, paste the link printed with the card instead.</p></section>`, { accountLabel, displayName, csrf, importJob })
}

// The scan sheet behind the search bar's QR button: Scan (the /meet camera
// flow, same element ids and the same explicit confirm) and My card (the
// member's own QR). Tabs are links, so either tab works without script; the
// page script switches them in place, stops the camera when it is hidden and
// starts it when Scan is shown. Signed-out visitors can scan; their My card
// tab offers sign-in instead.
export function renderScan({ accountLabel, displayName, csrf, importJob, tab = 'scan', profile, cardUrl, qr } = {}) {
  const onCard = tab === 'card'
  const tabLink = (id, href, label, selected) => `<a role="tab" id="tab-${id}" href="${href}" aria-controls="panel-${id}" aria-selected="${selected}"${selected ? '' : ' tabindex="-1"'}>${label}</a>`
  const scanPanel = `<div class="scan-cam"><div id="camera"></div><div class="scan-frame" aria-hidden="true"></div><p class="scan-hint">Point your camera at an Unlinked or OpenChat QR code</p></div><p id="status" class="small" role="status"></p><div id="confirm" class="notice" hidden><p>Scanned: <b id="confirm-label"></b></p><p class="small">Open it to continue. Opening a profile only shows its public page.</p><div class="actions"><a id="confirm-open" class="button sm" href="/meet">Open</a><button id="confirm-cancel" type="button" class="quiet sm">Cancel</button></div></div><div class="actions"><button id="start" type="button" class="sm">Start camera</button><button id="stop" type="button" class="quiet sm">Stop camera</button></div><details class="scan-paste"><summary>Paste a link instead</summary><form id="paste"><label for="card-url">Card or profile link</label><input id="card-url" type="text" inputmode="url" required><div class="actions"><button class="quiet sm">Check link</button></div></form></details><p class="small">Nothing opens until you confirm, and scanning never adds a contact or grants access by itself.</p>`
  const cardPanel = csrf
    ? cardFace({ profile, cardUrl, qr, heading: 'h2', actions: `<a class="button sm" href="/card">Open full card</a><a class="button sec sm" href="/profile">View profile</a>` })
    : `<div class="card"><h2>Your card</h2><p>Members get a QR code that opens their public Unlinked profile, ready to show when you meet someone.</p><div class="actions"><a class="button sm" href="/login?next=%2Fcard">Sign in to show your card</a><a class="button sec sm" href="/join">Join Unlinked</a></div></div>`
  return { camera: true, ...base('Scan', `<section class="narrow scan-sheet"><div class="sheet-top"><h1 class="hq">Scan or share</h1><a class="sheet-close" href="${csrf ? '/network' : '/'}" aria-label="Close">×</a></div><div class="tabs" role="tablist" aria-label="Scan a code or show your card">${tabLink('scan', '/scan', 'Scan', !onCard)}${tabLink('card', '/scan?tab=card', 'My card', onCard)}</div><div class="tabpanel" role="tabpanel" id="panel-scan" aria-labelledby="tab-scan"${onCard ? ' hidden' : ''}>${scanPanel}</div><div class="tabpanel" role="tabpanel" id="panel-card" aria-labelledby="tab-card"${onCard ? '' : ' hidden'}>${cardPanel}</div></section>`, { accountLabel, displayName, csrf, importJob }) }
}

// Runs after MEET_SCRIPT in the same module: tab switching for renderScan.
export const SCAN_TABS_SCRIPT = `{const tabs=[...document.querySelectorAll('.scan-sheet [role=tab]')],start=document.getElementById('start'),stop=document.getElementById('stop');const show=(tab,focus)=>{for(const t of tabs){const on=t===tab;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;document.getElementById(t.getAttribute('aria-controls')).hidden=!on}if(focus)tab.focus();history.replaceState(null,'',tab.getAttribute('href'));if(tab.id==='tab-scan')start.click();else stop.click()};for(const t of tabs){t.addEventListener('click',e=>{e.preventDefault();if(t.getAttribute('aria-selected')!=='true')show(t)});t.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();show(tabs[(tabs.indexOf(t)+1)%tabs.length],true)})}const close=document.querySelector('.sheet-close');close.addEventListener('click',e=>{try{if(history.length>1&&document.referrer&&new URL(document.referrer).origin===location.origin){e.preventDefault();stop.click();history.back()}}catch{}});if(document.getElementById('tab-scan').getAttribute('aria-selected')==='true')start.click()}`

// Short, server-side relative times; dates beyond a week.
const ago = (at, now) => {
  if (!Number.isSafeInteger(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(at).getUTCFullYear() !== new Date(now).getUTCFullYear() ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}
const profileHref = id => html(`/people/${encodeURIComponent(raw(id))}`)
const named = value => value.profileId ? `<a href="${profileHref(value.profileId)}"><b>${html(value.name)}</b></a>` : `<b>${html(value.name)}</b>`
const respondForm = (csrf, id, next = '') => `<form class="row-actions" method="post" action="/connections/respond">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(id)}">${next ? `<input type="hidden" name="next" value="${html(next)}">` : ''}<button class="quiet sm" name="action" value="ignore">Ignore</button><button class="sm" name="action" value="accept">Accept</button></form>`
const INVITATION_NOTICES = { ...CONNECT_NOTICES, accepted: 'Accepted. You are now connected.', ignored: 'Ignored. They are not told.', withdrawn: 'Invitation withdrawn.', connection_unavailable: 'That invitation is no longer available.', connection_not_found: 'That invitation is no longer available.' }

// My Network → Invitations: requests waiting for you, and the ones you sent.
export function renderInvitations({ accountLabel, displayName, csrf, importJob, tab = 'received', received = [], sent = [], notice, now = Date.now() } = {}) {
  const onSent = tab === 'sent'
  const tabLink = (href, label, selected) => `<a href="${href}"${selected ? ' aria-current="page"' : ''}>${label}</a>`
  const receivedRows = list(received).map(value => `<li class="req">${avatar(value.name, value.profileId ?? value.name)}<div class="req-body"><p>${named(value)} wants to connect</p>${value.note ? `<p class="req-note"><q>${html(value.note)}</q></p>` : ''}<p class="small">${html(ago(value.createdAt, now))}</p></div>${respondForm(csrf, value.id)}</li>`).join('')
  const sentRows = list(sent).map(value => `<li class="req">${avatar(value.name, value.profileId ?? value.name)}<div class="req-body"><p>${named(value)}</p>${value.note ? `<p class="req-note"><q>${html(value.note)}</q></p>` : ''}<p class="small">Sent ${html(ago(value.createdAt, now))} · Pending</p></div><form class="row-actions" method="post" action="/connections/withdraw">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(value.id)}"><input type="hidden" name="next" value="/invitations?tab=sent"><button class="quiet sm" type="submit">Withdraw</button></form></li>`).join('')
  const body = onSent
    ? (sentRows ? `<ul class="reqs">${sentRows}</ul>` : '<p class="small empty">No invitations waiting on anyone. Find people in <a href="/network">People</a> and press Connect on their profile.</p>')
    : (receivedRows ? `<ul class="reqs">${receivedRows}</ul>` : '<p class="small empty">No pending invitations. When someone asks to connect, it shows up here.</p>')
  return base('My Network', `<section class="narrow wide mynet"><h1 class="hq">My Network</h1><p class="lead">Invitations to connect with members of Unlinked.</p>${Object.hasOwn(INVITATION_NOTICES, raw(notice)) ? `<p class="notice" role="status">${html(INVITATION_NOTICES[notice])}</p>` : ''}<nav class="subtabs" aria-label="Invitations">${tabLink('/invitations', `Received${list(received).length ? ` · ${count(list(received).length)}` : ''}`, !onSent)}${tabLink('/invitations?tab=sent', `Sent${list(sent).length ? ` · ${count(list(sent).length)}` : ''}`, onSent)}<a href="/invites">Off-platform invites</a></nav><div class="card">${body}</div><p class="small">Accepting connects you both: each of you shows in the other’s people, and on both public profiles. Ignoring is private; the sender is not told. Inviting someone who is not on Unlinked yet? <a href="/invites">Create an invite link</a>.</p></section>`, { accountLabel, displayName, csrf, importJob })
}

const NOTIFICATION_TEXT = {
  connection_request_received: value => `${named(value)} wants to connect with you`,
  connection_request_accepted: value => `${named(value)} accepted your invitation to connect`,
  invite_accepted: value => `${named(value)} accepted your invite and joined Unlinked. You are now connected.`,
  profile_claimed: value => `${named(value)}, someone in your connections, joined Unlinked and claimed their profile`,
}
// The notification feed. `pending` maps request ids that still await an answer,
// so a request notification can be answered in place; `connected` holds request
// ids that are now connections (accepted, or added through a contact card), so
// an answered request says so instead of still asking.
export function renderNotifications({ accountLabel, displayName, csrf, importJob, items = [], pending = new Map(), connected = new Set(), pendingCount = 0, now = Date.now(), notice, emailEnabled = false } = {}) {
  const rows = list(items).filter(value => NOTIFICATION_TEXT[value.kind]).map(value => {
    // The whole row opens the item (and marks it read), so the name is not a separate link.
    const request = value.kind === 'connection_request_received'
    const waiting = request && pending.has(value.subjectId)
    const done = request && !waiting && connected.has(value.subjectId)
    const text = done ? `${named({ name: value.actorName })} is now connected with you` : NOTIFICATION_TEXT[value.kind]({ name: value.actorName })
    return `<li class="note${value.read ? '' : ' unread'}"><a class="note-open" href="/notifications/${html(value.id)}">${avatar(value.actorName, value.actorProfileId ?? value.actorName)}<span class="note-text">${text}${value.read ? '' : '<span class="vh"> (unread)</span>'}<span class="small note-time">${html(ago(value.createdAt, now))}${done ? ' · <span class="note-state">Connected</span>' : ''}</span></span></a>${waiting ? respondForm(csrf, value.subjectId, '/notifications') : ''}</li>`
  }).join('')
  const unread = list(items).some(value => !value.read)
  const summary = pendingCount > 0 ? `<a class="note-summary" href="/invitations">${NETWORK_NAV_ICON}<span><b>${count(pendingCount)} pending ${pendingCount === 1 ? 'invitation' : 'invitations'}</b><span class="small">Review them in My Network</span></span></a>` : ''
  return base('Notifications', `<section class="narrow wide notes"><div class="notes-top"><h1 class="hq">Notifications</h1>${unread ? `<form method="post" action="/notifications/read-all">${csrfInput(csrf)}<button class="quiet sm" type="submit">Mark all as read</button></form>` : ''}</div>${Object.hasOwn(CONNECT_NOTICES, raw(notice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[notice])}</p>` : ''}${summary}<div class="card">${rows ? `<ul class="note-list">${rows}</ul>` : '<p class="small empty">Nothing yet. Invitations to connect, people accepting yours, and people you know joining Unlinked show up here.</p>'}</div><p class="small">${emailEnabled ? 'Email notifications follow your <a href="/settings#email">email preferences</a>. Requests you have already seen here are not emailed.' : 'Notifications appear here. Email delivery is currently unavailable.'}</p></section>`, { accountLabel, displayName, csrf, importJob })
}

export function renderMessages({ accountLabel, displayName, csrf, profile } = {}) {
  const src = new URL('https://chat.ideaflow.app/app/')
  src.searchParams.set('embed', 'unlinked')
  if (profile) { src.searchParams.set('intent', 'compose'); src.searchParams.set('source', 'unlinked'); src.searchParams.set('profile', profile) }
  const standalone = new URL(src); standalone.searchParams.delete('embed')
  const view = base('Messages', `<section class="messages-page"><div class="messages-heading"><div><h1>Messages</h1><p>Your OpenChat inbox, right here.</p></div><a class="small" href="${html(standalone.href)}" target="_blank" rel="noopener noreferrer">OpenChat ↗</a></div><div class="messages-connection"><span id="messages-status" role="status">Connecting your inbox…</span><button id="messages-retry" class="link-button" hidden>Try again</button></div><iframe id="messages-frame" title="Your messages" src="${html(src.href)}" allow="microphone; camera; clipboard-write" referrerpolicy="strict-origin"></iframe><noscript><p><a href="${html(standalone.href)}">Open messages in OpenChat</a></p></noscript></section>`, { accountLabel, displayName, csrf })
  return { ...view, messaging: true }
}
