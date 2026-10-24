import { publicLinkedinUrl, publicWebsite, classifySocialLink, SOCIAL_LINK_LIMITS } from '../src/utils/public-people/profile-links.mjs'
import { parseAccountScope, scopeAllowsConnectionActions, scopeAllowsPrivateNotes } from './account-grants.mjs'
import { readFileSync } from 'node:fs'
import { OMNI_SEARCH_SCRIPT } from './omni-search.mjs'
import { profileDetailLevel, companyDetailLevel } from '../src/utils/public-people/detail-level.mjs'
import { ONBOARDING_STYLE } from './private-onboarding-style.mjs'
import { displayPhone, whatsappUrl, isSafeContactLink } from './contact-card.mjs'
import { PHOTO_URL } from './profile-photos.mjs'
import { HANDLE_LIMITS, profilePath } from '../src/utils/public-people/profile-handles.mjs'
import { unlinkedProfileContext } from '../src/utils/openchat-profile-context.mjs'
import { REMOVAL_REASONS, REPORT_REASONS, DETAILS_MAX } from './safety-reports.mjs'

const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
// Help and legal (docs/support-and-legal.md). Unlinked uses Ideaflow's company
// policies; /privacy and /terms on this site redirect to them.
export const SUPPORT_EMAIL = 'support@ideaflow.app'
export const FEEDBACK_URL = 'https://worldissuetracker.com/tracker/unlinked-ai'
export const PRIVACY_URL = 'https://www.ideaflow.io/privacy-policy'
export const TERMS_URL = 'https://www.ideaflow.io/terms-of-service'
// Deleting the Ideaflow ID itself (sign-in for every Ideaflow app) happens on
// id.ideaflow.app, which returns here afterwards. Unlinked's own data is
// deleted separately, in Settings → Your data.
export const IDEAFLOW_ID_DELETE_URL = 'https://id.ideaflow.app/account/delete?return_to=https://www.unlinked.ai'
const ideaflowIdDeletion = () => `<div class="ideaflow-id-delete"><h3>Also delete your Ideaflow ID</h3><p class="small">Unlinked signs you in with your Ideaflow ID, which is shared by every Ideaflow app (such as OpenChat). Deleting your Unlinked data keeps that sign-in. To remove the sign-in itself for all Ideaflow apps, delete your Ideaflow ID too.</p><p><a class="button sec sm" href="${IDEAFLOW_ID_DELETE_URL}">Also delete your Ideaflow ID</a></p></div>`

const raw = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const html = value => raw(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const list = value => Array.isArray(value) ? value : []
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'
const csrfInput = csrf => `<input type="hidden" name="csrf" value="${html(csrf)}">`
const openChatAction = profileUrl => `<a class="button sec sm" href="${html(profileUrl ? `/messages?profile=${encodeURIComponent(profileUrl)}` : '/messages')}">Message</a>`
const openChatNote = () => ''
const LINKEDIN_EXPORT = 'https://www.linkedin.com/mypreferences/d/download-my-data'
const LINKEDIN_AGENT_INSTRUCTION = 'Monitor the email account linked to my LinkedIn profile, including Inbox and Spam/Junk, for LinkedIn data export notices from messages-noreply@linkedin.com. Look for “The first installment of your LinkedIn data archive is ready!” and “Your full LinkedIn data archive is ready!” (or equivalent current wording). When each installment arrives, verify the message and download link are genuinely from LinkedIn, then automatically download the archive within 72 hours and save each file locally. Tell me which installment arrived and where you saved it. Do not upload or share the archive. If you need mailbox or LinkedIn access, ask me.'
const linkedinEmailHelp = id => `<span class="linkedin-email-help"><button class="linkedin-email-trigger" type="button" aria-controls="linkedin-email-${id}" aria-expanded="false">LinkedIn’s email</button><span class="linkedin-email-panel" id="linkedin-email-${id}" popover="auto" role="dialog" aria-label="What to look for in LinkedIn’s export email"><strong>What to look for</strong><span>From <code>messages-noreply@linkedin.com</code> to your LinkedIn email address.</span><span>Subject: <b>“The first installment of your LinkedIn data archive is ready!”</b> or <b>“Your full LinkedIn data archive is ready!”</b></span><span>Check Inbox and Spam/Junk. A full archive may arrive in two emails; download each within 72 hours.</span><span class="linkedin-agent-help"><button class="linkedin-agent-copy" type="button">Copy agent instruction to monitor and download</button><span class="linkedin-agent-copy-status" role="status" aria-live="polite"></span></span></span></span>`
export const LINKEDIN_EMAIL_HELP_SCRIPT = `(()=>{
  const agentInstruction=${JSON.stringify(LINKEDIN_AGENT_INSTRUCTION)};
  for (const help of document.querySelectorAll('.linkedin-email-help')) {
    const trigger=help.querySelector('.linkedin-email-trigger'), panel=help.querySelector('.linkedin-email-panel');
    let pinned=false, closeTimer;
    const position=()=>{
      const anchor=trigger.getBoundingClientRect(), width=panel.getBoundingClientRect().width;
      panel.style.left=Math.max(12,Math.min(anchor.left,innerWidth-width-12))+'px';
      const height=panel.getBoundingClientRect().height;
      panel.style.top=(anchor.bottom+8+height<=innerHeight-12?anchor.bottom+8:Math.max(12,anchor.top-height-8))+'px';
    };
    const open=()=>{clearTimeout(closeTimer);if(!panel.matches(':popover-open'))panel.showPopover();position();trigger.setAttribute('aria-expanded','true')};
    const close=()=>{clearTimeout(closeTimer);if(panel.matches(':popover-open'))panel.hidePopover();pinned=false;trigger.setAttribute('aria-expanded','false')};
    const scheduleClose=()=>{clearTimeout(closeTimer);if(!pinned)closeTimer=setTimeout(()=>{if(!panel.matches(':hover,:focus-within')&&!trigger.matches(':hover,:focus'))close()},180)};
    trigger.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse')open()});
    trigger.addEventListener('pointerleave',scheduleClose);
    trigger.addEventListener('focus',open);
    trigger.addEventListener('blur',scheduleClose);
    trigger.addEventListener('click',()=>{if(pinned)close();else{open();pinned=true}});
    panel.addEventListener('pointerenter',()=>clearTimeout(closeTimer));
    panel.addEventListener('pointerleave',scheduleClose);
    panel.addEventListener('focusin',()=>clearTimeout(closeTimer));
    panel.addEventListener('focusout',scheduleClose);
    panel.addEventListener('toggle',()=>{if(!panel.matches(':popover-open')){pinned=false;trigger.setAttribute('aria-expanded','false')}});
    const copy=panel.querySelector('.linkedin-agent-copy');
    copy?.addEventListener('click',async()=>{
      const status=panel.querySelector('.linkedin-agent-copy-status');
      try{await navigator.clipboard.writeText(agentInstruction);status.textContent='Copied';}
      catch{status.textContent='Clipboard unavailable in this browser.';}
    });
    addEventListener('resize',()=>{if(panel.matches(':popover-open'))position()});
  }
})();`;
const exportHelp = () => `<div class="export-help"><p class="small"><a data-linkedin-export href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Don't have your LinkedIn export yet? Request it now ↗</a></p><p class="small">The complete archive (recommended) is usually ready in about a day; Connections can take up to 48 hours. Sign up while you wait. Download your file within 3 days of ${linkedinEmailHelp('export-help')}, then upload it here.</p></div>`
// Browser-only progress: opening LinkedIn is remembered, never asserted as a
// submitted export request, account identity or an email/reminder timestamp.
export const LINKEDIN_EXPORT_PROGRESS_SCRIPT = `(()=>{
  const links=[...document.querySelectorAll('[data-linkedin-export]')];if(!links.length)return;
  const key='unlinked.linkedin-export-opened.v1',ttl=4*24*60*60*1000;
  let memoryAt=0;
  const valid=at=>Number.isFinite(at)&&at>0&&at<=Date.now()&&Date.now()-at<ttl;
  const read=()=>{try{const at=Number(localStorage.getItem(key));if(valid(at))return true;if(at)localStorage.removeItem(key)}catch{}return valid(memoryAt)};
  const labels=new Map(links.map(link=>[link,link.textContent]));
  const draw=opened=>{for(const link of links){link.classList.toggle('export-opened',opened);link.textContent=opened?'Export page opened ✓':labels.get(link);link.closest('li')?.classList.toggle('export-opened-step',opened)}const status=document.getElementById('linkedin-export-status');if(status){status.hidden=!opened}};
  for(const link of links)link.addEventListener('click',event=>{if(event.defaultPrevented||(event.button!==undefined&&event.button!==0))return;memoryAt=Date.now();try{localStorage.setItem(key,String(memoryAt))}catch{}draw(true)});
  addEventListener('pageshow',()=>draw(read()));
  addEventListener('storage',event=>{if(event.key===key||event.key===null){memoryAt=0;draw(read())}});
  draw(read());
})();`;

const exportSteps = () => `<ol><li>Open LinkedIn’s data download settings on a personal computer.</li><li>Choose “Download larger data archive” (recommended) for your full profile and connections, or select Connections.</li><li>Download your file within 3 days (72 hours) of ${linkedinEmailHelp('export-steps')}, then upload it here. Once downloaded, your saved file does not expire.</li></ol>`
// Keep native POSTs and their CSRF tokens on the current host.
const localAction = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\s\x00-\x1f\x7f#]/.test(value) ? value : null
const profileLookup = ({ linkedinLookup, lookupResult, csrf, address = '' }) => {
  const action = localAction(linkedinLookup?.action)
  const claimAction = lookupResult?.status === 'found' ? localAction(lookupResult.claimAction) : null
  return `${action ? `<form class="linkedin-lookup" method="post" action="${html(action)}">${csrfInput(csrf)}<label for="onboarding-linkedin-url">Find yourself on Unlinked <span class="small">Your LinkedIn address</span></label><input id="onboarding-linkedin-url" type="text" name="linkedinUrl" maxlength="2048" value="${html(address)}" placeholder="linkedin.com/in/your-name" autocomplete="url" autocapitalize="off" spellcheck="false"><p class="small">Checks saved Unlinked profiles, then tries your public LinkedIn page when lookup is available. Nothing is claimed until you confirm.</p><button class="quiet" type="submit">Find me</button></form>` : ''}${claimAction ? `<div class="panel lookup-result"><h2>Is this you?</h2>${lookupResult.test === true ? '<p class="notice test-profile" role="note"><b>Test profile.</b> Not a real person and never shown publicly. An operator can release the claim afterwards.</p>' : ''}${lookupResult.source === 'profile-lookup' ? `${avatar(lookupResult.profileName)}<p class="small">from your public LinkedIn profile</p>` : ''}<h3>${lookupResult.id && lookupResult.test !== true ? `<a href="${html(`${profilePath(lookupResult.id)}`)}" target="_blank" rel="noopener">${html(lookupResult.profileName)}</a> <a class="small" href="${html(`${profilePath(lookupResult.id)}`)}" target="_blank" rel="noopener">View profile ↗</a>` : html(lookupResult.profileName)}</h3><p>${html(lookupResult.headline)}</p>${lookupResult.location ? `<p class="small">${html(lookupResult.location)}</p>` : ''}${lookupResult.source === 'profile-lookup' ? `${experience(lookupResult.positions, 'Your export can add more experience.')}${education(lookupResult.education)}` : ''}${lookupResult.listedBy > 0 ? `<p>Listed by ${count(lookupResult.listedBy)} ${lookupResult.listedBy === 1 ? 'member' : 'members'}</p>` : ''}<form method="post" action="${html(claimAction)}">${csrfInput(csrf)}${lookupResult.claimToken ? `<input type="hidden" name="candidate" value="${html(lookupResult.claimToken)}">` : ''}<div class="actions"><button type="submit">Yes, that's me</button><a class="quiet" href="/profile">Not me</a></div></form></div>` : ''}`
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
  return `<a class="me-face" href="/profile" aria-label="Your profile" title="Your profile">${face}</a><details class="me"><summary aria-haspopup="menu" aria-label="Me: account menu${name ? ` for ${html(name)}` : ''}"><span class="me-l">Me<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></span></summary><div class="me-panel" role="menu" aria-label="Account"><div class="me-head" role="none">${face}<div class="me-who"><b>${html(name) || 'Your account'}</b>${ME_HEADLINE_SLOT}</div><a class="button sec sm me-view" role="menuitem" href="/profile">View profile</a></div><a role="menuitem" href="/card">${QR_ICON}My card</a><a role="menuitem" href="/scan">${SCAN_ICON}Scan a card</a><a role="menuitem" href="/settings">${GEAR_ICON}Settings &amp; agent setup</a><a role="menuitem" href="/support">${HELP_ICON}Help &amp; support</a><div class="me-sep" role="separator"></div><form method="post" action="/switch-account" role="none">${csrfInput(csrf)}<button type="submit" class="me-out" role="menuitem">Switch account</button></form><form method="post" action="/logout" role="none">${csrfInput(csrf)}<button type="submit" class="me-out" role="menuitem">Sign out</button></form></div></details>`
}
const HELP_ICON = '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M7.9 7.6a2.2 2.2 0 0 1 4.2.9c0 1.5-2.1 1.9-2.1 3.1M10 14.3h.01"/></svg>'
// The sign-in moment names the terms a new member agrees to.
const legalNote = (verb = 'continuing') => `<p class="small legal-note">By ${verb}, you agree to the Ideaflow <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>. Unlinked does not allow abusive or objectionable content. <a href="/support">Help &amp; support</a></p>`
const SCAN_ICON = '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 6.5v-3a1 1 0 0 1 1-1h3M13.5 2.5h3a1 1 0 0 1 1 1v3M17.5 13.5v3a1 1 0 0 1-1 1h-3M6.5 17.5h-3a1 1 0 0 1-1-1v-3M5 10h10"/></svg>'
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
// The member's headline is known once their profile has been read this session;
// until then the menu shows the name alone. Always escaped.
export const fillMeHeadline = (content, headline) => content.replace(ME_HEADLINE_SLOT, raw(headline).trim() ? `<span class="me-hl">${html(raw(headline).trim())}</span>` : '')
// Progressive enhancement for the global search and Me menu. Runs under each page's script nonce.
export const TOP_BAR_SCRIPT = `(()=>{const me=document.querySelector('details.me');if(!me)return;const sum=me.querySelector('summary'),items=()=>[...me.querySelectorAll('[role=menuitem]')];let byKey=false;const sync=()=>sum.setAttribute('aria-expanded',String(me.open));sync();me.addEventListener('toggle',()=>{sync();if(me.open&&byKey)items()[0]?.focus();byKey=false});sum.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')byKey=true;else if(e.key==='ArrowDown'&&!me.open){e.preventDefault();byKey=true;me.open=true}});me.addEventListener('keydown',e=>{if(!me.open)return;const list=items(),i=list.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();me.open=false;sum.focus()}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();list[e.key==='ArrowDown'?(i+1)%list.length:(i<=0?list.length-1:i-1)]?.focus()}else if(e.key==='Home'||e.key==='End'){e.preventDefault();list[e.key==='Home'?0:list.length-1]?.focus()}else if(e.key==='Tab')me.open=false});document.addEventListener('click',e=>{if(me.open&&!me.contains(e.target))me.open=false});me.addEventListener('focusout',e=>{if(me.open&&e.relatedTarget&&!me.contains(e.relatedTarget))me.open=false})})();(()=>{document.addEventListener('click',e=>{const b=e.target.closest?.('[data-copy-linkedin-export]');if(!b)return;const url='${LINKEDIN_EXPORT}';const done=t=>{b.textContent=t};try{navigator.clipboard.writeText(url).then(()=>done('Link copied. Paste it in Safari.'),()=>done(url))}catch{done(url)}})})();(()=>{const h=document.getElementById('pwa-hint');if(!h||/UnlinkediOS\\//.test(navigator.userAgent))return;const seen=()=>{try{return localStorage.getItem('pwa-hint-dismissed')}catch{return '1'}};if(matchMedia('(pointer:coarse)').matches&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone&&!seen())h.hidden=false;document.getElementById('pwa-hint-dismiss').addEventListener('click',()=>{h.hidden=true;try{localStorage.setItem('pwa-hint-dismissed','1')}catch{}})})();(()=>{document.addEventListener('click',e=>{for(const d of document.querySelectorAll('details.more-actions[open]'))if(!d.contains(e.target))d.open=false});document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;const d=e.target.closest?.('details.more-actions[open]');if(d){d.open=false;d.querySelector('summary').focus()}})})();` + OMNI_SEARCH_SCRIPT

// One search box, in the header of every page. A plain GET, so it works before
// sign-in, can be bookmarked and needs no script.
const headerSearch = ({ query, mode, presence, sort, connected }) => `<form class="header-search" method="get" action="/network" role="search">${presence ? `<input type="hidden" name="presence" value="${html(presence)}">` : ''}${sort ? `<input type="hidden" name="sort" value="${html(sort)}">` : ''}${connected ? '<input type="hidden" name="connected" value="1">' : ''}${mode === 'exact' ? '<input type="hidden" name="mode" value="exact">' : ''}<svg class="search-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 4 4"/></svg><input name="q" type="search" enterkeyhint="search" maxlength="200" aria-label="Search everyone on Unlinked" value="${html(query)}" placeholder="Search people, roles, companies"><button type="submit" aria-label="Search"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg></button><a class="scan" href="/scan" aria-label="Scan a QR code or show your card" title="Scan a card · show yours">${QR_ICON}</a><div class="omni-panel" hidden><div class="omni-status" role="status" aria-live="polite"></div><div id="omni-suggestions" role="listbox" aria-label="Search suggestions"></div></div></form>`
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
// world-issue-tracker-uonq (design review Option A): the footer used to
// link "Feedback ↗" straight out to the public WIT board. That's now the
// WIT feedback widget's own mount point — feedback-widget.mjs's
// feedbackWidgetTag() points data-mount-selector at #wit-feedback-slot, so
// the widget renders its inline text-link trigger here (opening the
// embedded capture panel in place) instead of a position:fixed floating
// bubble. One feedback entry point in the footer, not two. Renders empty
// (zero layout footprint) until the widget script attaches.
const footer = ({ csrf, accountLabel }) => `<footer><div class="foot-main"><div class="foot-brand"><b>unlinked</b><span>An open professional network</span></div><div class="foot-links" role="navigation" aria-label="Footer"><a href="/support">Support</a><a href="/data-liberation">Data liberation</a><a href="/agents">For agents</a><a href="https://www.unlinked.ai/meet" target="_blank" rel="noopener noreferrer">Meet someone in person ↗</a><a href="/llms.txt">llms.txt</a></div></div><div class="foot-meta"><span>Not affiliated with LinkedIn. · <span class="app-version">v${html(APP_VERSION)}</span></span><span class="foot-legal"><span id="wit-feedback-slot"></span><a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy</a><a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms</a>${csrf ? `<span class="account">${accountLabel ? `Signed in as ${html(accountLabel)} · ` : ''}<form class="sign-out" method="post" action="/logout">${csrfInput(csrf)}<button class="link-button">Sign out</button></form></span>` : ''}</span></div></footer>`
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
// The Messages link carries OpenChat's unread total when messaging is configured.
export const NAV_MESSAGES_SLOT = '<!--nav-messages-->'
const messagesCount = alerts => Number.isSafeInteger(alerts?.messages) && alerts.messages > 0 ? `<span class="nav-count" aria-label="${alerts.messages} unread">${badgeCount(alerts.messages)}</span>` : ''
export const fillNavAlerts = (content, alerts) => content.replace(NAV_ALERTS_SLOT, navAlerts(alerts)).replace(NAV_MESSAGES_SLOT, messagesCount(alerts))
// The account chip shows a name, never a full address or an opaque identifier.
const chipLabel = value => { const text = raw(value).trim(); return !text || /^[0-9a-f-]{20,}$/i.test(text) ? '' : text.includes('@') ? text.split('@')[0] : text }
// Signed out, the header has one sign-in control (Ideaflow ID also handles
// sign-up), omitted on pages whose body is the "Sign in with Ideaflow" button.
const base = (title, content, { accountLabel, displayName, csrf, importJob, query = '', mode, presence, sort, connected, network = false, signInInBody = false, statusBanner = true, signInNext = null } = {}) => ({ title, content: `<style>${ONBOARDING_STYLE}${HUES.map((color, index) => `.tone-${index}{--h:${color}}.unlinked-onboarding .avatar.tone-${index},.unlinked-onboarding .faces .tone-${index}{background:${color}}`).join('')}.mini-caption{margin:14px 24px 0}.connection-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.person>div{min-width:0}.person .connection-actions{margin-top:10px}.more-actions{position:relative;display:inline-block}.more-actions summary{list-style:none;cursor:pointer;display:inline-grid;place-items:center;width:38px;height:38px;border:1px solid var(--line2);border-radius:99px;color:var(--muted);background:#fff}.more-actions summary::-webkit-details-marker{display:none}.more-actions summary:hover,.more-actions[open] summary{background:var(--tint);color:var(--fg)}.more-actions summary:focus-visible{outline:3px solid var(--brand);outline-offset:2px}.phead:has(details.more-actions[open]){overflow:visible}.phead .banner{border-radius:inherit;border-bottom-left-radius:0;border-bottom-right-radius:0}.more-panel{position:absolute;z-index:20;top:calc(100% + 6px);right:0;width:min(280px,80vw);padding:12px 14px;border:1px solid var(--line2);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.14);font-size:13px}.more-panel p{margin:0 0 10px}.more-panel .more-links{display:flex;flex-direction:column;gap:2px;margin:0}.more-panel .more-links a{display:block;padding:8px 0;font-size:14px}.more-panel form+.more-links{border-top:1px solid var(--line);margin-top:10px;padding-top:6px}.blocked-note p{margin:0 0 8px}@media(max-width:640px){.profile-more .more-panel{position:fixed;top:auto;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));width:auto;z-index:60;font-size:15px;padding:8px 16px}.profile-more .more-panel .more-links a{padding:12px 0;font-size:16px}}</style><div class="unlinked-onboarding"><header><a class="logo" href="https://www.unlinked.ai/" aria-label="Unlinked home"><strong>unlinked</strong></a>${network ? `<a class="scan" href="/scan" aria-label="Scan a QR code or show your card">${QR_ICON}</a>` : headerSearch({ query, mode, presence, sort, connected })}<nav aria-label="Main navigation">${csrf ? `${jobPill(importJob)}<a class="my-card-link" href="/card" aria-label="My card">${QR_ICON}<span class="nav-lbl">My card</span></a><a href="/network?connected=1">People</a><a href="/messages" data-nav-messages>Messages${NAV_MESSAGES_SLOT}</a><a class="hide-m" href="/agents">For agents</a>${NAV_ALERTS_SLOT}${meMenu({ displayName, csrf })}` : `<a href="/people">Explore</a><a class="hide-m" href="/agents">For agents</a>${signInInBody ? '' : `<a class="button sm" href="${html(localAction(signInNext) ? `/login?next=${encodeURIComponent(signInNext)}` : '/login')}">Sign in</a>`}`}</nav></header>${statusBanner ? jobStatus(importJob) : ''}<main class="journey">${content}</main>${footer({ csrf, accountLabel })}</div>` })

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
  const links = [], seen = new Set()
  const add = (href, label, nofollow) => { if (href && !seen.has(href)) { seen.add(href); links.push(`<a href="${html(href)}" target="_blank" rel="noopener noreferrer${nofollow ? ' nofollow' : ''}">${html(label)} ↗</a>`) } }
  add(linkedin, 'LinkedIn profile', false)
  add(website, 'Website', true)
  // Member-published links (unlinked-8dm), re-validated here so only safe HTTPS
  // addresses render; a professional LinkedIn address above wins over a saved one.
  for (const entry of list(profile.socialLinks)) {
    const link = classifySocialLink(entry?.url)
    if (link && !(link.kind === 'linkedin' && linkedin)) add(link.url, link.label, true)
  }
  return links.length ? `<p class="small profile-links">${links.join(' · ')}</p>` : ''
}
const PRESENCE_FILTERS = [[undefined, 'All'], ['member', 'On Unlinked'], ['legacy', 'Legacy members'], ['shadow', 'Not yet on Unlinked']]
const subline = value => [raw(value.headline), raw(value.company)].filter(Boolean).join(' · ')
// Imported people who have not joined. A network icon marks those connected to
// more than one person here, so their page leads somewhere; a dot marks a stub.
const NETWORK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="3.5" cy="8" r="2"/><circle cx="12.5" cy="3.5" r="2"/><circle cx="12.5" cy="12.5" r="2"/><path d="M5.3 7.1 10.7 4.4M5.3 8.9l5.4 2.7"/></svg>'
const STUB_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>'
const reach = value => Number.isSafeInteger(value?.connectionCount) && value.connectionCount > 1
const shadowBadge = (value, { withCount = true } = {}) => value?.presence === 'legacy' ? '<span class="shadow" title="Recovered Unlinked account, awaiting confirmation at sign-in.">Legacy member · awaiting claim</span>' : value?.presence !== 'shadow' ? (value?.presence === 'member' ? '<span class="membership-member">On Unlinked</span>' : '') : reach(value)
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
const memberHref = value => html(`${profilePath(raw(value.id))}`)
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

// The Unlinked iOS app (user agent `UnlinkediOS/`, a web view): pages are
// adjusted once, on the server, after rendering (docs/ios-app-web.md).
// - LinkedIn's export page opens in Safari directly (`x-safari-https:`), which
//   skips the LinkedIn app (it has no export) and the in-app web view (not
//   signed in to LinkedIn); a Copy link fallback and the way back follow it.
// - The "Add to Home Screen" hint is for browsers, not the installed app.
export const IOS_EXPORT_HREF = `x-safari-https://${LINKEDIN_EXPORT.slice('https://'.length)}`
const IOS_EXPORT_HELP = '<span class="ios-export-help">It opens in Safari. When the file is ready, come back here and choose it from Files → Downloads. <button type="button" class="link-button" data-copy-linkedin-export>Copy link</button></span>'
export function iosAppView(content) {
  return String(content)
    .replace(/<div id="pwa-hint"[^>]*>[\s\S]*?<\/button><\/div>/g, '')
    .replace(new RegExp(`<a([^>]*?) href="${LINKEDIN_EXPORT.replace(/[.?/]/g, '\\$&')}" target="_blank" rel="noopener noreferrer">([\\s\\S]*?)<\\/a>`, 'g'), (_, attributes, label) => `<a${attributes} href="${IOS_EXPORT_HREF}">${label}</a>${IOS_EXPORT_HELP}`)
    // Other services' export pages (Data liberation) also open in
    // Safari, where people are signed in; the app's web view is not.
    .replace(/<a([^>]*?) data-export-link href="https:\/\//g, '<a$1 data-export-link href="x-safari-https://')
}

export function renderLanding({ inApp = null } = {}) {
  const escapeExport = escapeHref(LINKEDIN_EXPORT, inApp), escapeHome = escapeHref('https://www.unlinked.ai/', inApp)
  const banner = inApp ? `<div class="notice in-app" role="note"><p>You’re in ${html(inApp.app)}’s browser, which isn’t signed in to LinkedIn. Unlinked works best in ${html(inApp.browser)}.</p>${escapeHome ? `<a class="button sec brand" href="${html(escapeHome)}">Open Unlinked in ${html(inApp.browser)}</a>` : ''}<p class="small">Didn’t open? Tap ••• and choose <b>Open in ${html(inApp.browser)}</b>.</p></div>` : ''
  return base('Your professional profile and network', `${banner}<section class="land"><div><h1>Your professional profile and network, in a place that’s yours.</h1><p class="lead">Bring your profile and connections from LinkedIn. Explore who knows whom. Ask your AI agent who you need.</p><ol class="land-steps" aria-label="How to join"><li><span class="n">1</span><div><b>Ask LinkedIn for your file</b><p class="small">Choose the <b>complete archive (recommended)</b> for your profile and connections. Usually ready in about a day; some data can take up to 48 hours. Download within 3 days of ${linkedinEmailHelp('landing')}.</p>${escapeExport ? `<a class="button lg" data-linkedin-export aria-describedby="linkedin-export-status" href="${html(escapeExport)}">Start my LinkedIn export ↗</a>` : `<a class="button lg" data-linkedin-export aria-describedby="linkedin-export-status" href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Start my LinkedIn export ↗</a>`}<p id="linkedin-export-status" class="small land-hint" role="status" aria-live="polite" hidden>If you requested your archive, check your inbox for ${linkedinEmailHelp('export-status')}. You can create your profile while you wait.</p><p class="small land-hint">On a phone? It works in Safari or Chrome, not in the LinkedIn app.</p></div></li><li><span class="n">2</span><div><b>Create your profile while you wait</b><p class="small">Paste your LinkedIn address and we’ll find you.</p><a class="button lg" href="/join">Create my profile</a></div></li><li class="later"><span class="n">3</span><div><b>Upload the file when it arrives</b><p class="small">Your connections become searchable here and from Claude. Already have it? <a href="/join">Bring my file</a></p></div></li></ol><p class="land-explore"><a href="/people">or explore profiles first →</a></p>${legalNote('joining')}</div><div>${sampleProfile()}</div></section><section class="agent-demo"><div><p class="eyebrow">Built for AI agents too</p><h2>Ask Claude about your own network.</h2><p class="lead">Connect Unlinked once. Claude, ChatGPT or Cursor can then search your people and everyone on Unlinked.</p><pre>https://www.unlinked.ai/mcp</pre><a href="/agents">How agents connect and what to upload →</a></div><figure class="claude-demo" aria-label="Example Claude conversation using Unlinked"><figcaption>✳ Claude</figcaption><div class="demo-user">Find gaming investors in my network.</div><p class="demo-tool">⚙ <b>unlinked</b> · searched your connections</p><ol class="demo-answer"><li><b>Maya Chen</b>, GP at Emberfield Ventures <span>— fund focused on games</span></li><li><b>Priya Shah</b>, Partner at Alderbridge Capital <span>— leads consumer and gaming deals</span></li><li><b>Marcus Reed</b>, Investor at Cedarpath Ventures <span>— former game studio producer</span></li></ol><p class="small demo-note">Example with fictional people.</p></figure></section>`)
}

export function renderJoin({ signedIn = false, accountLabel, displayName, csrf, importJob } = {}) {
  return base('Join Unlinked', `<section class="narrow">${steps(1)}<h1 class="hq">Join Unlinked</h1><p class="lead">Bring the people you know into reach.</p><div class="sign-in-options"><a class="button" href="/login">Sign in with Ideaflow</a></div><p class="small">One button for new and returning members. Google, email and password are all on the Ideaflow sign-in page, the same account as OpenChat.</p>${legalNote('signing in')}${!signedIn ? exportHelp() : ''}<p class="small"><a href="/people">Explore profiles first</a></p></section>`, signedIn ? { accountLabel, displayName, csrf, importJob } : { signInInBody: true })
}

// A member page was opened without a session. Sign-in returns to that page.
export function renderSignInRequired({ next } = {}) {
  const target = localAction(next) ? `/login?next=${encodeURIComponent(next)}` : '/login'
  return base('Sign in to continue', `<section class="narrow"><h1 class="hq">Sign in to continue</h1><p class="lead">This page belongs to your account. Anyone can search and read profiles without signing in.</p><div class="sign-in-options"><a class="button" href="${html(target)}">Sign in with Ideaflow</a></div><p class="small">New here? The same button creates your account. <a href="/people">Explore profiles</a></p>${legalNote('signing in')}</section>`, { signInInBody: true })
}

export function renderBringArchive({ accountLabel, displayName, csrf, publicProfessionalSearch = false, limitBytes = 67108864, state = 'ready', errorMessage, syntheticMode = false, importJob, reminder, refresh }) {
  const size = Number.isSafeInteger(limitBytes) && limitBytes > 0 ? Math.floor(limitBytes / 1048576) : 64
  // A member who already imported is here to bring a newer export: no
  // getting-started steps, and their current import is named honestly.
  const title = refresh ? 'Upload a newer LinkedIn export' : 'Bring your LinkedIn export'
  const lead = refresh ? `<p class="lead">${html(importLine(refresh))} A newer export adds anyone you have connected with since; your current import stays.</p>` : '<p class="lead">Your full LinkedIn ZIP builds your profile and brings your connections. Connections-only ZIP or CSV also works.</p>'
  // On Home only: hide this reminder. A display choice; it changes no import.
  const hide = reminder === 'dismissible' ? `<form class="reminder-hide" method="post" action="/home/import-reminder">${csrfInput(csrf)}<input type="hidden" name="reminder" value="dismissed"><button class="link-button" type="submit">Hide this from Home</button><span class="small"> · You can import any time from Home or Settings.</span></form>` : ''
  const links = refresh ? '<p><a href="/">Back to Home</a> · <a href="/settings">Import details</a></p>' : '<p><a href="/profile">Skip for now</a> · <a href="/network">Explore people</a></p>'
  return base(title, `<section class="narrow">${refresh ? '' : steps(2)}<h1 class="hq">${title}</h1>${lead}${state === 'error' ? `<p class="notice error" role="alert">${html(errorMessage) || 'That file could not be imported. Try again, or choose Connections.csv from your archive.'}</p>` : ''}<form id="onboarding-upload" method="post" action="/upload" enctype="multipart/form-data">${csrfInput(csrf)}<label class="file">Choose your LinkedIn file<input required type="file" name="archive" accept=".zip,.csv"><span class="small">ZIP or CSV · up to ${size} MB</span></label>${syntheticMode ? '<label><input required type="checkbox" name="syntheticConsent" value="yes"> This is synthetic test data.</label>' : ''}<button id="onboarding-import" type="submit">Import my file</button><p class="small">${publicProfessionalSearch ? 'By importing, your profile and the people in your file can be found on Unlinked by members and visitors. Contact details and your original file stay private.' : 'By importing, your profile and connections join your Unlinked network, searchable by you and by any agent you connect. Contact details stay private.'}</p><section id="onboarding-progress" hidden role="status" aria-live="polite"><h2>Importing…</h2><progress aria-label="Importing your LinkedIn file"></progress><p>Uploading your file. Keep this page open until the upload finishes; the import then continues on the server.</p></section></form>${exportHelp()}<details><summary>Don’t have your export yet?</summary>${exportSteps()}</details>${links}${hide}</section>`, { accountLabel, displayName, csrf, importJob })
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

// The member's own public links (unlinked-8dm), edited as one address per
// line and previewed exactly as the public header renders them. These are
// public by design; contact details belong on the contact card, never here.
const SOCIAL_LINK_NOTICES = {
  saved: 'Saved. Your links are part of your public profile.',
  invalid: 'That link could not be used. Use web addresses like x.com/you or https://you.substack.com.',
  limit: `Keep it to ${SOCIAL_LINK_LIMITS.maxLinks} links.`,
}
const socialLinksCard = ({ socialLinks, csrf }) => {
  if (!socialLinks || !csrf) return ''
  const links = list(socialLinks.links).map(entry => classifySocialLink(entry?.url)).filter(Boolean)
  const notice = SOCIAL_LINK_NOTICES[raw(socialLinks.notice)]
  const line = socialLinks.notice === 'invalid' && Number.isSafeInteger(socialLinks.line) && socialLinks.line > 0 ? ` (line ${socialLinks.line})` : ''
  return `<div class="card sec" id="public-links"><h3>Links</h3><p class="small">Shown with your public profile: LinkedIn, X, Substack, GitHub or any website.</p>${links.length ? `<p class="small profile-links">${links.map(link => `<a href="${html(link.url)}" target="_blank" rel="noopener noreferrer nofollow">${html(link.label)} ↗</a>`).join(' · ')}</p>` : ''}${notice ? `<p class="notice${socialLinks.notice === 'saved' ? '' : ' error'}" role="${socialLinks.notice === 'saved' ? 'status' : 'alert'}">${html(notice + line)}</p>` : ''}<form method="post" action="/profile/links">${csrfInput(csrf)}<label for="profile-links-input">Your links <span class="small">One address per line, up to ${SOCIAL_LINK_LIMITS.maxLinks}. Leave empty to remove them all.</span></label><textarea id="profile-links-input" name="links" rows="4" maxlength="2000" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="x.com/you&#10;you.substack.com">${html(list(socialLinks.links).map(entry => entry?.url).filter(Boolean).join('\n'))}</textarea><div class="actions"><button class="sm" type="submit">Save links</button></div>${socialLinks.canPublish === false ? '<p class="small">They will appear once your profile is published on Unlinked.</p>' : ''}<p class="small">These are public. Phone numbers and email addresses belong on <a href="/card">your contact card</a>, not here.</p></form></div>`
}
// The member's handle (docs/profile-handles.md): the readable address of their
// public profile. Earlier handles keep redirecting here, so changing it never
// breaks a shared link. The page script checks availability as you type.
const HANDLE_NOTICES = {
  saved: 'Saved. Your profile address is updated; earlier addresses still lead here.',
  taken: 'That handle is taken. Try another.',
  invalid: 'Use lowercase letters, numbers and single hyphens, starting and ending with a letter or number.',
  length: `Use ${HANDLE_LIMITS.min} to ${HANDLE_LIMITS.max} characters.`,
  reserved: 'That handle is reserved. Try another.',
  limit: `You have used ${HANDLE_LIMITS.perProfile} handles, the most allowed. You can switch back to one you used before.`,
  unavailable: 'Your handle could not be changed right now. Please try again in a minute.',
}
const profileHandleCard = ({ profileHandle, csrf }) => {
  if (!profileHandle?.handle || !csrf) return ''
  const handle = raw(profileHandle.handle), notice = HANDLE_NOTICES[raw(profileHandle.notice)], ok = profileHandle.notice === 'saved'
  return `<div class="card sec" id="profile-handle"><h3>Profile address</h3><p class="small">Your public profile is at <a href="${html(`/people/${encodeURIComponent(handle)}`)}">unlinked.ai/people/${html(handle)}</a>.</p>${notice ? `<p class="notice${ok ? '' : ' error'}" role="${ok ? 'status' : 'alert'}">${html(notice)}</p>` : ''}<form method="post" action="/profile/handle" data-handle-form>${csrfInput(csrf)}<label for="profile-handle-input">Handle <span class="small">unlinked.ai/people/…</span></label><input id="profile-handle-input" name="handle" value="${html(handle)}" required minlength="${HANDLE_LIMITS.min}" maxlength="${HANDLE_LIMITS.max}" pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="profile-handle-status"><p class="small" id="profile-handle-status" aria-live="polite"></p><button class="sm" type="submit">Save handle</button></form></div>`
}
// Progressive enhancement for the handle field: a debounced availability check.
export const PROFILE_HANDLE_SCRIPT = `(()=>{const form=document.querySelector('[data-handle-form]');if(!form)return;const input=form.querySelector('#profile-handle-input'),status=form.querySelector('#profile-handle-status');let timer,seq=0;
const say=t=>{status.textContent=t};const messages={taken:'Taken.',invalid:'Use lowercase letters, numbers and single hyphens.',length:'Use ${HANDLE_LIMITS.min} to ${HANDLE_LIMITS.max} characters.',reserved:'Reserved.',unavailable:'Can\u2019t check right now.'};
input.addEventListener('input',()=>{clearTimeout(timer);const value=input.value.trim();if(!value){say('');return}timer=setTimeout(async()=>{const mine=++seq;try{const r=await fetch('/profile/handle/check?handle='+encodeURIComponent(value),{credentials:'same-origin'});const d=await r.json();if(mine!==seq)return;say(d.available?(d.current?'This is your current handle.':'Available.'):(messages[d.code]||'Not available.'))}catch{if(mine===seq)say('')}},300)})})()`
export function renderOwnProfile({ accountLabel, displayName, csrf, publicProfessionalSearch = false, profile = {}, contacts = [], connectionCount, imports = [], importJob, linkedinLookup, lookupResult, testClaim, summary, socialLinks, profileHandle }) {
  const people = list(contacts), files = list(imports).length
  // Files recovered from the member's original Unlinked account are an import too (unlinked-5e5).
  const recovered = !files && summary?.recovered?.complete === true, imported = files > 0 || summary?.hasImport === true
  const total = Number.isSafeInteger(connectionCount) && connectionCount >= people.length ? connectionCount : people.length
  const facts = [raw(profile.location), raw(profile.industry), total ? `${count(total)} ${total === 1 ? 'connection' : 'connections'}` : ''].filter(Boolean).join(' · ')
  return base("Here's your profile", `<section class="profile"><div><div class="card phead"><div class="banner"></div>${profileFace(profile)}<h1>${html(profile.name) || 'Your profile'}</h1>${profile.headline ? `<p class="hl">${html(profile.headline)}</p>` : ''}${facts ? `<span class="small">${html(facts)}</span>` : ''}${profile.company ? `<p class="small">${companyLink(profile.company)}</p>` : ''}${profileLinks(profile)}${testClaim?.name ? `<p class="notice test-claim" role="status"><b>Test profile claimed:</b> ${html(testClaim.name)}. This is test data. It is not public and is not part of your profile, network or agent.</p>` : ''}<div class="actions">${imported ? `<a class="button" href="/network">See my people</a><a class="button sec" href="/card">My card</a><a class="button sec" href="/import">${files ? 'Add another file' : 'Upload a newer export'}</a>` : `<a class="button" href="/import">Bring my LinkedIn export</a><a class="button sec" href="/card">Show my card</a>`}<a class="button sec" href="/settings#agent">Connect my agent</a></div><p class="notice">${imported ? 'Built from your LinkedIn file. To update it, upload a newer export.' : 'Next: bring your LinkedIn export. It fills in your experience, education and connections. Meanwhile, your card is ready to share.'}</p></div>${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, 'A full archive can include your experience.')}${education(profile.education)}${skills(profile.skills)}${profileHandleCard({ profileHandle, csrf })}${socialLinksCard({ socialLinks, csrf })}${profileLookup({ linkedinLookup, lookupResult, csrf })}</div><aside><div class="card sec"><h3>My connections${total ? ` · ${count(total)}` : ''}</h3>${people.length ? `${people.slice(0, 10).map(connectionRow).join('')}<p class="small"><a href="/network">See all the people you know →</a></p>` : (imported ? '<p class="small">Your connections could not be shown right now.</p><p><a href="/network">See your people →</a></p>' : '<p class="small">Bring your LinkedIn export to fill this in.</p><p><a href="/import">Add a file →</a></p>')}</div><p class="small">${files ? `${files} ${files === 1 ? 'file has' : 'files have'} been added to your account.` : recovered ? 'Your LinkedIn files from your original Unlinked account are on this account.' : 'You can add your file later.'} ${publicProfessionalSearch ? 'Contact details and your original file stay private.' : 'Your people remain private to your account.'}</p></aside></section>`, { accountLabel, displayName, csrf, importJob })
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
const businessCard = ({ name, headline, location, photo, heading = 'h1', rows = '', side = '', empty = 'Your card', qrFirst = false }) => `<div class="bcard${side ? '' : ' solo'}${side && qrFirst ? ' qr-first' : ''}"><div class="bc-main"><div class="bc-id">${photoSrc(photo) ? photoImg('bc-av photo', photo, name, 64) : `<span class="bc-av" aria-hidden="true">${html(initials(name)) || '·'}</span>`}<div><${heading} class="bc-name">${html(name) || empty}</${heading}>${raw(headline) ? `<p class="bc-hl">${html(headline)}</p>` : ''}${raw(location) ? `<p class="small">${html(location)}</p>` : ''}</div></div>${rows ? `<ul class="bc-rows">${rows}</ul>` : ''}</div>${side ? `<div class="bc-side">${side}</div>` : ''}</div>`
// The public card face, shared by /card and the My card tab of /scan.
const cardFace = ({ profile = {}, cardUrl, qr, heading = 'h1', actions }) =>
  `${businessCard({ name: profile.name, headline: profile.headline, location: profile.location, photo: profile.photo, heading, qrFirst: true, rows: linkedinRow(profile.linkedinUrl), side: cardUrl && qr ? `<div class="qr">${qr}</div><p class="small">Scan to open my public profile</p>` : '' })}${cardUrl && qr ? `<p class="small qr-url"><code>${html(cardUrl)}</code></p>` : '<p class="notice">Your QR code appears once your profile is published on Unlinked. Bring your LinkedIn export to publish it.</p>'}<div class="actions">${actions}</div><p class="small">This card shows only what is already public: no phone number, email address or file contents.</p>`
const CONTACT_FIELDS = [
  ['phone', 'showPhone', 'Phone', 'tel', 'tel', '+1 415 555 0123', 'With the country code.'],
  ['whatsapp', 'showWhatsapp', 'WhatsApp', 'tel', 'off', 'Same as phone', 'Leave the number empty to use your phone number.'],
  ['email', 'showEmail', 'Email', 'email', 'email', 'you@example.com', ''],
  ['link', 'showLink', 'Website or link', 'url', 'url', 'https://example.com', ''],
]
// An empty field starts switched on (it shows nothing until it is filled in);
// WhatsApp starts off, since it can borrow the phone number.
// The share switch starts on unless the member switched it off: editing a card means sharing it.
const contactForm = (settings, csrf, share = true) => `<form class="card cc-form" method="post" action="/card/contact">${csrfInput(csrf)}<input type="hidden" name="shareCardSwitch" value="1"><label class="check cc-share-switch"><input type="checkbox" name="shareCard" value="yes"${share ? ' checked' : ''}> <span><b>Share my card</b> <span class="small">People who scan it see your name and headline, plus what you switch on below.</span></span></label>${CONTACT_FIELDS.map(([field, show, label, inputmode, autocomplete, placeholder, hint]) => {
  const on = settings[show] === true || (field !== 'whatsapp' && !raw(settings[field]))
  return `<div class="cc-field"><label for="cc-${field}">${label}${hint ? ` <span class="small">${hint}</span>` : ''}</label><input id="cc-${field}" type="text" name="${field}" inputmode="${inputmode}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false" maxlength="254" placeholder="${html(placeholder)}" value="${html(settings[field])}"><label class="check"><input type="checkbox" name="${show}" value="yes"${on ? ' checked' : ''}> Show on my contact card</label></div>`
}).join('')}<div class="actions"><button type="submit">Save</button></div><p class="small">To hide a detail, switch it off and save. To stop sharing the whole card, switch off Share my card: its link then shows nothing.</p></form>`
// After someone joins or connects from a card: the new member's own card and
// QR, so the person who shared theirs can scan back. `own` is the owner's view
// of their contact card ({ card, shareUrl, qr }).
export const shareBackBlock = ({ heading, note, own, name }) => own?.qr && own.shareUrl ? `<section class="share-back" aria-labelledby="share-back-title"><h2 id="share-back-title">${heading}</h2><p class="small">${note}</p>${businessCard({ name: own.card?.name || name, headline: own.card?.headline, heading: 'h3', qrFirst: true, rows: contactRows(own.card), side: `<div class="qr">${own.qr}</div><p class="small">Scan to save my contact and connect</p>` })}<div class="actions"><a class="button sm" href="/card">Edit my card</a><a class="button sec sm" href="/network?connected=1">My connections</a></div></section>` : ''
// A one-tap way to put the sign-in email on the card. The address comes from
// the session on the server, never from the form.
const addEmailForm = (accountEmail, csrf) => accountEmail ? `<form class="cc-add-email" method="post" action="/card/contact/email">${csrfInput(csrf)}<button class="quiet sm" type="submit">Add ${html(accountEmail)} to my card</button><span class="small"> One tap. Only people you show your card to see it.</span></form>` : ''
export function renderCard({ accountLabel, displayName, csrf, importJob, profile = {}, cardUrl, qr, contact = null, share = 'contact', notice, error, accountEmail = null }) {
  const onContact = Boolean(contact) && share === 'contact'
  const tab = (href, label, selected) => `<a href="${href}"${selected ? ' aria-current="page"' : ''}>${label}</a>`
  const tabs = contact ? `<nav class="tabs" aria-label="Card version">${tab('/card?share=contact', 'Contact card', onContact)}${tab('/card?share=public', 'Public profile', !onContact)}</nav>` : ''
  const details = `${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, '')}${education(profile.education)}${skills(profile.skills)}`
  const scan = '<a class="button sec sm" href="/scan?tab=scan">Scan someone’s card</a>'
  // Shown by TOP_BAR_SCRIPT on phones only, when the page is not already running
  // as the installed app and the member has not dismissed it. Below the card,
  // so the QR code is the first thing on the page.
  const pwaHint = `<div id="pwa-hint" class="notice pwa-hint" hidden><span><b>Keep your card one tap away.</b> In your browser’s Share or menu, choose Add to Home Screen.</span><button id="pwa-hint-dismiss" type="button" class="quiet sm" aria-label="Dismiss">Not now</button></div>`
  const top = `<div class="card-top"><h1 class="hq">My card</h1>${tabs}</div>${notice ? `<p class="notice" role="status">${html(notice)}</p>` : ''}${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}`
  if (!onContact) {
    const actions = `${cardUrl ? `<a class="button sec sm" href="${html(cardUrl)}">Preview my public profile</a>` : '<a class="button sm" href="/import">Add my file</a>'}${scan}`
    return base('My card', `<section class="narrow wide card-page">${top}${cardFace({ profile, cardUrl, qr, heading: 'h2', actions })}<p class="small">Scanning this code opens your public Unlinked profile, nothing more.</p>${contact ? '' : addEmailForm(accountEmail, csrf)}${pwaHint}${details}</section>`, { accountLabel, displayName, csrf, importJob })
  }
  const live = Boolean(contact.card && contact.shareUrl)
  const settings = contact.settings ?? {}
  const face = businessCard({ name: profile.name, headline: profile.headline, location: profile.location, photo: profile.photo, heading: 'h2', qrFirst: true, rows: contactRows(contact.card),
    side: live && contact.qr ? `<div class="qr">${contact.qr}</div><p class="small">Scan to save my contact and connect</p>` : '' })
  const nameOnly = live && !(contact.card.phone || contact.card.whatsapp || contact.card.email || contact.card.link)
  const emailShown = settings.showEmail === true && Boolean(settings.email)
  const link = live ? `<div class="cc-share"><label for="cc-link-out">Link to this card</label><input id="cc-link-out" type="text" readonly value="${html(contact.shareUrl)}"></div><div class="actions"><a class="button sec sm" href="${html(contact.shareUrl)}">See what they see</a>${scan}</div>` : `<p class="notice">Your card isn’t shared right now. Switch on Share my card below, or add a detail and save; your card then gets its QR code and link.</p><div class="actions">${scan}</div>`
  const reset = live ? `<details class="cc-reset"><summary>Reset the link…</summary><p class="small">You get a new link and QR code. The old ones stop working for everyone who has them.</p><form method="post" action="/card/contact/reset">${csrfInput(csrf)}<button class="quiet sm" type="submit">Reset my contact card link</button></form></details>` : ''
  const lead = `<p class="small cc-lead">Show this code to someone you meet. They can save your contact and connect with you on Unlinked, even without an account. Only people with the code or link can open it; your public profile never shows these details.</p>`
  return base('My card', `<section class="narrow wide card-page">${top}${face}${nameOnly ? '<p class="small cc-name-only">Only your name is on this card so far. Add your email, phone or a link below.</p>' : ''}${!emailShown ? addEmailForm(accountEmail, csrf) : ''}${link}${lead}${pwaHint}${details}<h2>What this card shares</h2>${contactForm(settings, csrf, settings.shareCard !== false)}${reset}</section>`, { accountLabel, displayName, csrf, importJob })
}

// What a contact card link opens, signed in or not. `card` is the consent
// projection (or null: unknown, reset, or nothing shown). Never indexed.
export function renderContactCard({ accountLabel, displayName, csrf, card, token, canAdd = false, canMessage = false, messageError = null, relation, addError = false, added = false, own = null } = {}) {
  if (!card) return base('Contact card', `<section class="narrow"><h1 class="hq">This card is not available</h1><p class="lead">Its owner may have reset the link or stopped sharing. Ask them for a new one.</p><p><a href="/">Learn about Unlinked</a></p></section>`, { accountLabel, displayName, csrf })
  const first = firstName(card.name), who = html(first || card.name || 'this person')
  // Join & connect: one POST that signs up or signs in with Ideaflow and then
  // connects; nothing happens on viewing or scanning alone.
  const join = `<form class="cc-join" method="post" action="/c/${html(token)}/add">${csrf ? csrfInput(csrf) : ''}<button type="submit">${csrf ? `Add ${who} to my connections` : `Join Unlinked &amp; connect with ${who}`}</button><p class="small">${csrf ? 'Their shared card lets you connect right away.' : `Free. Create your account (or sign in) with Ideaflow, and you and ${who} are connected as soon as you’re back. No LinkedIn import needed.`}</p></form>`
  const self = relation === 'self'
  const connected = relation === 'connected'
  const message = canMessage && csrf && !self ? `<form class="cc-message" method="post" action="/c/${html(token)}/message">${csrfInput(csrf)}<button type="submit">Message ${who}</button><p class="small">Start a conversation in Unlinked.</p></form>` : ''
  const messageNotice = messageError === 'blocked' ? '<p class="notice" role="status">You’ve blocked this person. Manage blocked people in Settings to message them.</p>' : messageError === 'failed' ? '<p class="notice error" role="alert">We couldn’t open the conversation. Please try Message again.</p>' : ''
  const success = connected && added ? `<p class="notice ok" role="status"><b>You and ${html(card.name) || who} are connected.</b></p>${messageNotice}${message}${shareBackBlock({ heading: 'Here’s your card, share it back', note: `Let ${who} scan this so they have your details too.`, own, name: displayName })}` : ''
  const state = self ? `<p class="notice" role="status"><b>This is your card.</b> This is what people see when they scan it. <a href="/card">Edit my card</a></p>`
    : !canAdd ? '' : connected ? (added ? '' : '<p class="notice" role="status">Added to your connections.</p><p><a href="/network?connected=1">View my connections →</a></p>') : join
  return base(raw(card.name) || 'Contact card', `<section class="narrow">${success}<p class="ph cc-kicker">Contact card</p>${businessCard({ name: card.name, headline: card.headline, location: card.location, rows: contactRows(card), empty: 'Unlinked member' })}${addError ? '<p class="notice error" role="alert">We couldn’t add this person. Please try again.</p>' : ''}${state}${connected && added ? '' : messageNotice + message}<div class="actions"><a class="button sec" href="${html(`/c/${raw(token)}/contact.vcf`)}">Save contact</a>${card.profilePath ? `<a class="button sec" href="${html(card.profilePath)}">View profile</a>` : ''}</div><p class="small cc-foot">${self ? 'Only people with this link or its QR code can open it.' : `${first ? `${html(first)} shared` : 'Shared'} with you through an Unlinked contact card. These details are not on a public profile; please keep them to yourself.`}</p>${csrf ? '' : '<p class="small">Unlinked is an open professional network. <a href="/join">Make your own card →</a></p>'}</section>`, { accountLabel, displayName, csrf, signInNext: `/c/${raw(token)}` })
}

// The early, optional find-yourself step: a LinkedIn address is a lookup hint,
// never proof of ownership or an import. Nothing is claimed without the
// explicit "Yes, that's me" confirmation, and skipping costs nothing.
// Someone you know who is not on Unlinked: kept with your own people, never
// published. LinkedIn's own export format needs both names and the profile URL.
export const renderPageShell = base

export function renderAddPerson({ accountLabel, displayName, csrf, importJob, error, values = {} } = {}) {
  const field = (name, label, hint, required = false, type = 'text') => `<label>${label}${required ? '' : ' <span class="small">(optional)</span>'}<input name="${name}" type="${type}" maxlength="${type === 'url' ? 2048 : 120}"${required ? ' required' : ''} value="${html(values[name])}">${hint ? `<span class="small">${hint}</span>` : ''}</label>`
  return base('Add a person', `<section class="narrow"><h1 class="hq">Add a person</h1><p><a href="/people/lookup">Find them from a LinkedIn URL ↗</a></p><p class="lead">Someone you know who is not on Unlinked. They join your own people, searchable by you and your agent. They are not published, and they are not told. Only a name is needed.</p>${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}<form method="post" action="/people/add">${csrfInput(csrf)}${field('firstName', 'First name', '', true)}${field('lastName', 'Last name')}${field('linkedinUrl', 'LinkedIn profile', 'For example https://www.linkedin.com/in/their-name', false, 'url')}${field('company', 'Company')}${field('position', 'Role')}<button type="submit">Add to my people</button></form><p class="small"><a href="/invites">Invite someone to join instead →</a></p></section>`, { accountLabel, displayName, csrf, importJob })
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
  connection_note_invalid: 'Keep the note under 300 characters.', connection_unavailable: 'That invitation is no longer available.', connection_not_found: 'That invitation is no longer available.', connection_not_member: 'They are not on Unlinked yet.', connection_not_available: 'You can’t connect with this person.', blocked: 'Blocked. They can’t message you or ask to connect, and they are not told.', unblocked: 'Unblocked.', block_failed: 'We could not finish blocking. Try again.',
}
export const connectNoticeCodes = Object.freeze(Object.keys(CONNECT_NOTICES))
const connectedMenu = ({ connect, csrf, id, name, next }) => connect?.state === 'connected' && connect.requestId ? `<details class="more-actions"><summary aria-label="More actions for ${html(name || 'this person')}" title="More">${DOTS_ICON}</summary><div class="more-panel"><p>Remove ${html(name || 'this person')} from your member connections? This removes the connection for both of you. Nobody is notified. Your imported files and claimed profiles stay.</p><form method="post" action="/connections/remove">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}"><input type="hidden" name="next" value="${html(next ?? `${profilePath(id)}`)}"><button class="quiet sm">Remove connection</button></form></div></details>` : ''
const connectControl = ({ connect, csrf, id, name, next, row = false, menu = true }) => {
  if (!connect) return ''
  const back = `<input type="hidden" name="next" value="${html(next ?? `${profilePath(id)}`)}">`
  // Signed out (often a scanned public QR): one POST that signs up or signs in
  // with Ideaflow, then sends the request (docs/contact-card.md, "Joining from a scan").
  if (connect.state === 'signed-out') return `<form class="connect" method="post" action="${html(`${profilePath(id)}/join`)}"><button class="sm" type="submit">${PLUS_ICON}Join Unlinked &amp; connect${firstName(name) ? ` with ${html(firstName(name))}` : ''}</button></form>`
  if (connect.state === 'self') return '<a class="button sec sm" href="/profile">This is you · My profile</a>'
  // Removal is rare, so it sits behind the "…" menu rather than beside Connected;
  // a profile places that menu at the end of its actions (`menu: false`).
  if (connect.state === 'connected') return `<span class="state-pill ok">✓ Connected</span>${menu ? connectedMenu({ connect, csrf, id, name, next }) : ''}`
  if (connect.state === 'outgoing') return `<span class="state-pill">Request sent · Pending</span><form method="post" action="/connections/withdraw">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}">${back}<button class="quiet sm" type="submit">Withdraw</button></form>`
  if (connect.state === 'incoming') return `<form method="post" action="/connections/respond">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}">${back}<button class="sm" name="action" value="accept">Accept invitation</button><button class="quiet sm" name="action" value="ignore">Ignore</button></form>`
  if (connect.state === 'none') return `<form${row ? '' : ' id="connect-form"'} class="connect" method="post" action="/connections/request">${csrfInput(csrf)}<input type="hidden" name="profileId" value="${html(id)}">${back}<button class="sm" type="submit">${PLUS_ICON}Connect</button></form>`
  if (connect.state === 'invite') return '<a class="button sec sm" href="/invites">Invite to Unlinked</a>'
  return ''
}
// The optional note sits under the buttons and submits with the Connect form.
const connectNote = who => `<details class="connect-note"><summary>Add a note</summary><label for="connect-note">A short note for ${html(who)} <span class="small">(optional, up to 300 characters)</span></label><textarea id="connect-note" name="note" form="connect-form" rows="3" maxlength="300"></textarea><button class="sm" type="submit" form="connect-form">Send with note</button></details>`
const DOTS_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>'
const PLUS_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

// Narrowing a person's connections: a filter field plus All / You both know /
// On Unlinked. Native GET links and form; the profile script updates in place.
const CONNECTION_SHOWS = [[undefined, 'All'], ['known', 'You both know'], ['members', 'On Unlinked']]
const connectionShowHref = (path, { query, sort, show }, hash = '') => {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (sort && sort !== 'detail') params.set('sort', sort)
  if (show) params.set('show', show)
  return `${path}${params.size ? `?${params}` : ''}${hash}`
}
const connectionShows = ({ path, query, sort, show, facets = {}, total, knownOffered, hash }) => `<nav class="network-segments pconn-shows" aria-label="Which connections">${CONNECTION_SHOWS.filter(([value]) => value !== 'known' || knownOffered).map(([value, label]) => {
  const tally = value === undefined ? facets.all ?? total : value === 'members' ? facets.members : facets.known
  const badge = Number.isSafeInteger(tally) ? ` <span>${count(tally)}</span>` : ''
  return `<a href="${html(connectionShowHref(path, { query, sort, show: value }, hash))}"${value === show ? ' aria-current="true"' : ''}>${label}${badge}</a>`
}).join('')}</nav>`

// The profile's "•••" menu: remove connection (when connected), report, block
// (a signed-in viewer, a member) and request removal (an imported profile).
const profileMenu = ({ connect, csrf, id, name, canBlock = false, removable = false }) => {
  if (!id) return ''
  const who = html(name || 'this person'), path = `${profilePath(id)}`
  const remove = connect?.state === 'connected' && connect.requestId ? `<p>Remove ${who} from your member connections? This removes the connection for both of you. Nobody is notified.</p><form method="post" action="/connections/remove">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(connect.requestId)}"><input type="hidden" name="next" value="${html(path)}"><button class="quiet sm">Remove connection</button></form>` : ''
  return `<details class="more-actions profile-more"><summary aria-label="More actions for ${who}" title="More">${DOTS_ICON}</summary><div class="more-panel">${remove}<p class="more-links"><a href="${html(`${path}/report`)}">Report ${who}</a>${canBlock ? `<a href="${html(`${path}/block`)}">Block ${who}</a>` : ''}${removable ? `<a href="${html(`${path}/removal`)}">Request removal</a>` : ''}</p></div></details>`
}

export function renderPerson({ accountLabel, displayName, csrf, importJob, profile = {}, connect, connectNotice, connectionQuery = '', connectionSort = 'detail', connectionShow, connectionsView = false, privateContext = false, blocked = null, canBlock = false, shareBack = null } = {}) {
  const connections = list(profile.connections), id = raw(profile.id), tone = hue(id || profile.name)
  const connectionPath = `${profilePath(id)}/connections`
  const connectionParams = new URLSearchParams({ q: connectionQuery, sort: connectionSort, ...(connectionShow ? { show: connectionShow } : {}) })
  const more = typeof profile.nextConnectionsCursor === 'string' && profile.nextConnectionsCursor ? `${connectionPath}?${connectionParams}&cursor=${encodeURIComponent(profile.nextConnectionsCursor)}` : null
  const total = Number.isSafeInteger(profile.connectionCount) ? profile.connectionCount : null
  const known = total ? `${count(total)} ${total === 1 ? 'connection' : 'connections'}` : connections.length ? `${count(connections.length)}${more ? '+' : ''} ${connections.length === 1 && !more ? 'connection' : 'connections'}` : ''
  const basicNote = (profile.detailLevel ?? profileDetailLevel(profile)) === 'basic' ? `<p class="small depth-note">${BASIC_PAGE_ICON} Basic profile · Additional details haven’t been listed yet.</p>` : ''
  const shadowNote = profile.presence === 'legacy' ? `<p class="small shadow-note">${shadowBadge(profile)} · Your old profile is preserved. <a href="/legacy-account">Sign in to reclaim it</a>.</p>` : profile.presence === 'shadow' ? `<p class="small shadow-note">${shadowBadge(profile, { withCount: false })} · Imported profile. Is this you? <a href="${csrf ? '/find-me' : '/join'}">Claim it</a></p>` : ''
  const facts = [raw(profile.location), raw(profile.industry), known].filter(Boolean).join(' · ')
  const owner = firstName(profile.name)
  const openChatContext = unlinkedProfileContext(profile.id)
  // "You both know" is for a signed-in viewer looking at someone else.
  const knownOffered = Boolean(csrf) && connect?.state !== 'self'
  const filter = { query: raw(connectionQuery), sort: connectionSort, show: connectionShow }
  if (connectionsView) return renderProfileConnections({ accountLabel, displayName, csrf, importJob, profile, query: connectionQuery, sort: connectionSort, show: connectionShow, knownOffered, more })
  const matching = Number.isSafeInteger(profile.connectionsTotal) ? profile.connectionsTotal : connections.length
  const narrowed = Boolean(filter.query || filter.show)
  const whose = owner ? `${html(owner)}’s` : 'their'
  const sideList = `<div class="card sec pconn" id="connections" data-profile-connections><h3>${owner ? `${html(owner)}’s connections` : 'Connections'}${total ? ` · ${count(total)}` : connections.length ? ` · ${count(connections.length)}${more ? '+' : ''}` : ''}</h3>${total || narrowed ? `<form class="pconn-filter" method="get" action="${html(`${profilePath(id)}#connections`)}" role="search"><label class="sr-only" for="pconn-q">Filter ${whose} connections</label><input id="pconn-q" name="q" type="search" maxlength="200" value="${html(filter.query)}" placeholder="Filter by name, role or company" autocomplete="off" enterkeyhint="search">${filter.sort !== 'detail' ? `<input type="hidden" name="sort" value="${html(filter.sort)}">` : ''}${filter.show ? `<input type="hidden" name="show" value="${html(filter.show)}">` : ''}<button class="sr-only" type="submit">Filter</button></form>${connectionShows({ path: `${profilePath(id)}`, ...filter, facets: profile.connectionFacets, total: filter.query ? undefined : total, knownOffered, hash: '#connections' })}` : ''}<p class="small pconn-status" role="status">${narrowed ? `${count(matching)} ${matching === 1 ? 'match' : 'matches'}${filter.query ? ` for “${html(filter.query)}”` : ''}${narrowed ? ` · <a href="${html(`${profilePath(id)}#connections`)}">Clear</a>` : ''}` : ''}</p>${connections.length ? connections.map(connectionRow).join('') : `<p class="small">${narrowed ? (filter.show === 'known' && !filter.query ? 'You don’t share any connections yet.' : filter.show === 'members' && !filter.query ? 'None of them are on Unlinked yet.' : 'No connections match.') : 'None listed yet.'}</p>`}${connections.length ? `<p class="small pconn-all"><a href="${html(connectionShowHref(connectionPath, filter))}">${!more ? 'Open the full list →' : Number.isSafeInteger(profile.connectionsTotal) ? `See all ${count(matching)} ${narrowed ? 'matches' : 'connections'} →` : `See all ${narrowed ? 'matches' : 'connections'} →`}</a></p>` : ''}</div>`
  // Right after "Join Unlinked & connect": the outcome and the new member's own card, first.
  const joined = shareBack ? `<p class="notice ok" role="status"><b>${connectNotice === 'sent' ? `Request sent to ${html(profile.name) || 'them'}.` : html(CONNECT_NOTICES[raw(connectNotice)] ?? 'Welcome to Unlinked.')}</b></p>${shareBackBlock({ heading: 'Here’s your card, share it back', note: `Let ${html(owner || 'them')} scan this so they have your details too.`, own: shareBack, name: displayName })}` : ''
  if (shareBack) connectNotice = undefined
  return base(raw(profile.name) || 'Profile', `<section class="profile"><div>${joined}<div class="card phead"><div class="banner tone-${HUES.indexOf(tone)}"></div>${profileFace(profile, ` tone-${HUES.indexOf(tone)}`)}<h1>${html(profile.name)}</h1>${profile.headline ? `<p class="hl">${html(profile.headline)}</p>` : ''}${facts ? `<span class="small">${html(facts)}</span>` : ''}${profile.company ? `<p class="small">${companyLink(profile.company)}</p>` : ''}${profileLinks(profile)}${basicNote}${shadowNote}${profile.presence === 'member' ? '<p class="small membership-member">On Unlinked</p>' : ''}${connect?.state === 'incoming' ? `<p class="notice invite-note">${html(owner || 'They')} ${owner ? 'wants' : 'want'} to connect with you.${connect.note ? ` <q>${html(connect.note)}</q>` : ''}</p>` : ''}${Object.hasOwn(CONNECT_NOTICES, raw(connectNotice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[connectNotice])}</p>` : ''}${blocked ? `<div class="notice blocked-note" role="status"><p>You blocked ${html(profile.name) || 'this person'}. They can’t message you or ask to connect.</p><form method="post" action="/blocks/unblock">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(blocked.id)}"><input type="hidden" name="next" value="${html(`${profilePath(id)}`)}"><button class="quiet sm" type="submit">Unblock</button></form></div>` : ''}<div class="actions">${blocked ? '' : connectControl({ connect, csrf, id, name: profile.name, menu: false })}${blocked ? '' : profile.presence === 'shadow' ? (connect?.state === 'invite' ? '' : '<a class="button sec sm" href="/invites">Invite to Unlinked</a>') : profile.presence === 'legacy' ? '' : openChatAction(openChatContext)}${csrf || connect ? '' : '<a class="button sm" href="/join">Join Unlinked</a>'}<a class="button sec sm" href="${csrf ? '/network' : '/people'}">Search everyone</a>${connect?.state === 'self' ? '' : profileMenu({ connect: blocked ? null : connect, csrf, id, name: profile.name, canBlock: canBlock && !blocked, removable: ['shadow', 'legacy'].includes(profile.presence) })}</div>${openChatNote(openChatContext)}${connect?.state === 'none' ? connectNote(firstName(profile.name) || 'them') : ''}${['shadow', 'legacy'].includes(profile.presence) && id ? `<p class="small removal-link" style="margin-top:14px">Is this about you? <a href="${profilePath(id)}/removal">Request removal</a></p>` : ''}${connect?.state === 'self' ? '<p class="small self-note">This is your public profile: what people see when they scan your public QR code.</p>' : ''}${connect?.state === 'signed-out' ? '<p class="small">Free. Create your account (or sign in) with Ideaflow; your request is sent as soon as you’re back.</p>' : ''}</div>${privateContext && csrf && id ? privateContextMount(`/api/private-context/people/${encodeURIComponent(id)}`, profile.name) : ''}${profile.about ? `<div class="card sec"><h3>About</h3><p>${html(profile.about)}</p></div>` : ''}${experience(profile.positions, 'Not listed.')}${education(profile.education)}${skills(profile.skills)}</div><aside>${sideList}</aside></section>`, { accountLabel, displayName, csrf, importJob })
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

export function renderProfileConnections({ accountLabel, displayName, csrf, importJob, profile, query = '', sort = 'detail', show, knownOffered = false, more }) {
  const path = `${profilePath(profile.id)}/connections`
  const shows = connectionShows({ path, query, sort, show, facets: profile.connectionFacets, total: query ? undefined : profile.connectionCount, knownOffered })
  const total = profile.connectionsTotal ?? profile.connections.length
  return base(`${profile.name}’s connections`, `<section class="dir"><p class="small"><a href="${memberHref(profile)}">← ${html(profile.name)}’s profile</a></p><h1 class="hq">${html(profile.name)}’s connections</h1><p class="small">${count(total)} ${query || show ? 'matching' : 'listed'} connections · ${BASIC_PAGE_ICON} indicates a basic profile with no additional details yet.</p><form class="connection-filters" method="get" action="${html(path)}" role="search"><label>Search connections<input type="search" name="q" maxlength="2048" value="${html(query)}" placeholder="Name, role or company"></label><label>Order<select name="sort"><option value="detail"${sort === 'detail' ? ' selected' : ''}>More detail first</option><option value="name"${sort === 'name' ? ' selected' : ''}>Name A–Z</option></select></label>${show ? `<input type="hidden" name="show" value="${html(show)}">` : ''}<button type="submit">Apply</button>${query ? `<a href="${html(connectionShowHref(path, { sort, show }))}">Clear search</a>` : ''}</form>${shows}${profile.connections.length ? `<div class="panel list">${profile.connections.map(member).join('')}</div>` : `<p class="notice">${query ? 'No connections match this search.' : show === 'known' ? 'You don’t share any connections yet.' : show === 'members' ? 'None of these connections are on Unlinked yet.' : 'No public connections listed yet.'}</p>`}${more ? `<p><a class="button sec" href="${html(more)}">Show more connections</a></p>` : ''}<p class="small">Only connections already shared on Unlinked are shown.</p></section>`, { accountLabel, displayName, csrf, importJob })
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

export function renderPeople({ membersOnly = false, accountLabel, displayName, csrf, query = '', mode = 'best', presence, sort, total, added = false, match, everyone, own, contacts, searchResults, aiMatches, aiNote, aiError, anonymousAi = false, nextCursor, nextContactPage, state = 'ready', importJob, publicProfessionalSearch, connectedCounts, connectedView, scope, returnTo = '/network', notice }) {
  sort ??= connectedView ? 'connected' : 'best'
  const exact = mode === 'exact', kept = presence === 'member' || presence === 'legacy' || presence === 'shadow' ? presence : undefined
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
  // The iOS app lists only members, so it has no membership filter (docs/ios-app-directory.md).
  const presenceFilter = membersOnly ? '' : `<nav class="network-segments" aria-label="Membership status">${PRESENCE_FILTERS.map(([value, label]) => `<a href="${html(filterHref(value))}"${value === kept ? ' aria-current="true"' : ''}>${label}</a>`).join('')}</nav>`
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
  const toolbar = `<div class="network-toolbar">${connectedCounts ? `<nav class="network-scopes" aria-label="People to show"><a href="${html(scopeHref(true))}"${connectedView ? ' aria-current="true"' : ''}>My connections <span>${count(connectedCounts.all)}</span></a><a href="${html(scopeHref(false))}"${!connectedView ? ' aria-current="true"' : ''}>Everyone</a></nav>` : ''}<form id="network-filters" method="get" action="/network" role="search" aria-label="Filter current list">${kept ? `<input type="hidden" name="presence" value="${kept}">` : ''}${connectedView ? '<input type="hidden" name="connected" value="1">' : ''}${exact ? '<input type="hidden" name="mode" value="exact">' : ''}<div class="network-fields"><label class="network-query" for="network-query"><span class="network-query-label">${connectedView ? 'Filter my connections' : 'Filter people'}</span><input id="network-query" name="q" type="search" maxlength="2048" placeholder="Name, company, role, or keyword" value="${html(query)}" autocomplete="off" enterkeyhint="search" aria-describedby="network-search-help"></label><label class="network-sort" for="network-sort">Sort by<select id="network-sort" name="sort">${options.map(([value, label]) => `<option value="${value}"${value === selectedSort ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button class="network-apply sec" type="submit">Apply</button></div><p id="network-search-help" class="small">Filter this list by name, company, role, or keyword.</p></form><div class="network-filter-row">${presenceFilter ? `<span class="small network-filter-label">Membership</span>${presenceFilter}` : ''}${query || kept || sort !== (connectedView ? 'connected' : 'best') ? `<a class="network-reset" href="${connectedView ? '/network?connected=1' : '/network'}">Clear filters</a>` : ''}</div></div>`
  // Every card on the page counts once: people you know plus everyone else.
  const visibleCount = connectedView ? list(connectedView.rows).length : list(everyone).length + (everyone !== undefined && own !== undefined && !legacy ? list(own).length : 0)
  const resultCount = connectedView?.total ?? total
  const summary = `<p class="network-count small" role="status" aria-live="polite">${Number.isSafeInteger(resultCount) ? `Showing ${count(visibleCount)} of ${count(resultCount)} ${query || kept ? 'matching ' : ''}${connectedView ? 'connections' : 'people'}` : ''}</p>`
  const dateNote = sort === 'connected' ? '<p class="small network-note">Newest connection dates first, from LinkedIn or accepted Unlinked connections. Unknown dates appear last.</p>' : sort === 'imported' ? '<p class="small network-note">Most recently imported first. This is when you brought people into Unlinked, not when you first connected. Unknown dates appear last.</p>' : ''
  const everyoneTitle = kept === 'member' ? 'On Unlinked' : kept === 'legacy' ? 'Legacy members' : kept === 'shadow' ? 'Not yet on Unlinked' : 'Everyone on Unlinked'
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
  return base('People', `<section class="dir" data-network><h1 class="hq">${raw(query) ? `Results for “${html(query)}”` : 'People'}</h1>${toolbar}<div data-network-results>${summary}${dateNote}${modes}${Object.hasOwn(CONNECT_NOTICES, raw(notice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[notice])}</p>` : ''}${raw(query) || connectedView ? '' : `<p class="lead">${state === 'welcome' ? "You're in. " : ''}${own === undefined ? 'People on Unlinked, ready to search.' : 'The people you know, ready to search.'}</p>`}${added ? '<p class="notice" role="status">Added to your people. They appear here once processed, usually within a minute.</p>' : ''}${askAi}${state === 'error' ? '<p class="notice error" role="alert">We could not read your people right now. Try again; this does not mean your network is empty.</p>' : `${connectedView ? `<section aria-label="My connections"><h2>${kept === 'member' ? 'My connections on Unlinked' : 'My connections'} · ${count(connectedView.total)}</h2>${state === 'unavailable' ? '<p class="notice">Connections could not be read. Try again.</p>' : list(connectedView.rows).length ? `<div class="panel list">${connectedView.rows.map(value => row(value, member)).join('')}</div>` : '<p class="notice">No connections match this filter.</p>'}${connectedView.nextPage !== undefined ? `<a href="${html(`${filterHref(kept)}${filterHref(kept).includes('?') ? '&' : '?'}page=${connectedView.nextPage}`)}">Show more</a>` : ''}</section>` : `${aiGroup}${ownGroup}${contactMore}${everyoneGroup}${more}`}`}</div><p class="small">${csrf ? '<a href="/people/add">Add a person</a> · <a href="/invites">Invite someone</a> · ' : ''}Friends come soon.</p></section>`, { accountLabel, displayName, csrf, importJob, query, mode, presence: kept, sort, connected: Boolean(connectedView), network: true })
}

// Settings' email section, only while email is on. The member's own address is the only one shown.
const emailSection = email => {
  if (!email) return ''
  const choices = Object.entries(email.labels ?? {}).map(([kind, label]) => `<label><input type="checkbox" name="kinds" value="${html(kind)}"${email.preferences?.[kind] ? ' checked' : ''}> ${html(label)}</label>`).join('')
  return `<h2 id="email">Email</h2><div class="card">${email.saved ? '<p class="notice" role="status">Email settings saved.</p>' : ''}${email.address ? `<p>Emails go to <b>${html(email.address)}</b>, the address you sign in with.</p>` : '<p class="notice">We do not have a verified email address for your account yet, so we send you no email. Sign out and sign in again to add the one you sign in with.</p>'}<form method="post" action="/settings/email">${csrfInput(email.csrf)}${choices}<button class="quiet" type="submit">Save email settings</button></form><p class="small">At most one email every 15 minutes; several updates arrive together. Anything you already saw on Unlinked is not emailed. Every email has a one-click unsubscribe link.</p></div>`
}

export function renderSettings({ blocks = null, accountLabel, displayName, csrf, publicProfessionalSearch = false, imports = [], grants = [], agentConfiguration, agentSetups, selectedKeyId, keyManagement = false, connector, importJob, deleteError, agentAccess, connectionActionsAvailable = false, email, recoveredFileCount = 0 }) {
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
  // People this member blocked (docs/report-and-block.md); shown when blocking is available.
  const blockedCard = Array.isArray(blocks) ? `<h2 id="blocked">Blocked people</h2><div class="card">${blocks.length ? blocks.map(value => `<div class="blocked-row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0"><span>${value.blockedProfileId ? `<a href="${profilePath(raw(value.blockedProfileId))}">${html(value.name) || 'Someone'}</a>` : html(value.name) || 'Someone on OpenChat'}</span><form method="post" action="/blocks/unblock">${csrfInput(csrf)}<input type="hidden" name="id" value="${html(value.id)}"><input type="hidden" name="next" value="/settings#blocked"><button class="quiet sm" type="submit">Unblock</button></form></div>`).join('') : '<p>You haven’t blocked anyone.</p>'}<p class="small">Blocked people can’t message you or ask to connect, and they are not told. Block someone from their profile’s ••• menu or a conversation’s ⋯ menu.</p></div>` : ''
  const helpCard = `<h2 id="help">Help &amp; legal</h2><div class="card"><p>Questions, a problem, or something that shouldn’t be here? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> or see <a href="/support">Help &amp; support</a>.</p><p><a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy ↗</a> · <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service ↗</a> · <a href="${FEEDBACK_URL}" target="_blank" rel="noopener noreferrer">Feedback board ↗</a></p></div>`
  const agentCard = `${manual}${connector ? `<section aria-label="Connect with sign-in"><h3>Connect with sign-in</h3>${connectorSection(connector, connections, csrf)}</section>` : ''}`
  // API keys and MCP setup come after the personal settings: most members never need them.
  const agentSection = `<h2 id="agent">Your agent: API keys &amp; MCP</h2><div class="card">${agentCard}<p class="small"><a href="/agents">How agents connect and what to upload</a></p></div>${sharedConnector}`
  return base('Settings', `<section class="narrow wide"><h1 class="hq">Settings</h1><div class="acct"><span>Signed in as <b>${html(accountLabel)}</b></span><form method="post" action="/logout">${csrfInput(csrf)}<button class="quiet sm" type="submit" title="Ends this session on this device. Your profile, files and agent access stay.">Sign out</button></form></div>${emailSection(email && { ...email, csrf })}<h2>Privacy</h2><div class="card"><p>${publicProfessionalSearch ? 'Your original file and contact details stay private. New imports make professional profiles and connections findable by members and visitors; earlier private imports remain private.' : 'Your file, profile and connections stay private to your account.'} When you or an agent you connect searches, OpenAI receives the search query and a limited set of relevant names, companies, roles and connection dates. Contact email addresses and phone numbers are never sent.</p><p>Your own phone number and other contact details appear only on your contact card, for people you give its link to. <a href="/card?share=contact">Manage my contact card</a></p></div><h2>Your files</h2><div class="card">${list(imports).map(value => `<details><summary>${html(value.filename)} · import details</summary><p>${count(value.accepted)} records accepted · ${count(value.indexed)} indexed${value.status === 'partial' && value.rejected ? ` · ${count(value.rejected)} ${value.rejected === 1 ? 'row' : 'rows'} skipped` : ''}.</p><p>${value.status === 'partial' && value.rejected && !value.failedFiles ? 'finished · rows with no name or LinkedIn address were skipped' : html(value.status)}</p>${value.errorMessage ? `<p class="notice error">${html(value.errorMessage)}</p>` : ''}<p>Professional profiles and connections: ${value.visibility === 'public' ? 'public' : 'private'}.</p>${value.sha256 ? `<p>SHA-256: <code>${html(value.sha256)}</code></p>` : ''}${/^[a-zA-Z0-9_-]+$/.test(raw(value.id)) ? `<a href="/imports/${encodeURIComponent(raw(value.id))}">View technical details</a>` : ''}</details>`).join('') || (recoveredFileCount > 0 ? '<p>No new uploads. Your LinkedIn files recovered from your original Unlinked account are listed below.</p>' : '<p>No files added yet.</p>')}<p><a href="/import">${list(imports).length || recoveredFileCount > 0 ? 'Upload a newer export →' : 'Add a file →'}</a></p></div><h2 id="your-data">Your data</h2><div class="card"><p>Your profile, connections and files belong to you. Take a full copy, or erase everything, whenever you want.</p><form method="get" action="/export"><button class="quiet" type="submit">Download everything (JSON)</button></form><p class="small">One file with your profile, every import and the people in it, recovered legacy records, your agent grants, and the private notes and relations you keep about people.</p><p class="small">Want copies from LinkedIn, Google, Facebook and other services too? <a href="/data-liberation">Data liberation →</a></p><details${deleteError ? ' open' : ''}><summary>Delete everything…</summary><p>This permanently erases your imports, profile, connections, receipts and agent access, and removes you from the public People index. There is no undo. You can sign in again later, but you start from nothing.</p><p class="small">Private notes and relations about people belong to your Ideaflow account and are shared with OpenChat, so they are kept. Delete them in OpenChat or ask your agent to.</p>${deleteError ? `<p class="notice error" role="alert">${html(deleteError)}</p>` : ''}<form method="post" action="/delete-account">${csrfInput(csrf)}<label for="delete-confirm">Type <b>delete everything</b> to confirm</label><input id="delete-confirm" type="text" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="delete everything"><button class="danger" type="submit">Permanently delete my data</button></form>${ideaflowIdDeletion()}</details></div>${blockedCard}${helpCard}${agentSection}</section>`, { accountLabel, displayName, csrf, importJob })
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
  return base('Your data is deleted', `<section class="narrow"><h1 class="hq">Your data is deleted</h1><p class="lead">Your imports, profile, connections and agent access have been erased, and you no longer appear in the public People index.</p><p>If you ever want to come back, sign in again and bring a fresh LinkedIn export.</p><p><a class="button" href="/">Back to the home page</a></p><div class="card sec">${ideaflowIdDeletion()}</div></section>`)
}

// The callback answered a sign-in this browser never started: almost always an
// Ideaflow ID email-verification link opened outside the app (or in another
// browser). Nothing was exchanged; say where to continue.
export function renderSignInElsewhere({ inApp = false } = {}) {
  return base('Email verified', `<section class="narrow"><h1 class="hq">Your email is verified</h1><p class="lead">Go back to the Unlinked app and sign in.</p><p>${inApp ? 'Tap Sign in to continue.' : 'This link opened outside the app (or in a different browser) from where you started, so we can’t finish signing you in here. Your account is ready: open Unlinked where you signed up and tap <b>Sign in</b>.'}</p><div class="actions"><a class="button" href="/login">${inApp ? 'Sign in' : 'Sign in here instead'}</a><a class="button sec" href="/">Home</a></div></section>`, { signInInBody: true })
}

// A signed-in page that does not exist: a real page with a way back, never a blank screen.
export function renderNotFound({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('Page not found', `<section class="narrow"><h1 class="hq">Page not found</h1><p class="lead">This page doesn’t exist, or it has moved.</p><div class="actions"><a class="button" href="/">Go to Home</a><a class="button sec" href="/network">People</a><a class="button sec" href="/card">My card</a></div><p class="small">Expected something here? <a href="/support">Help &amp; support</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

// The public People index could not be read: say so in a page, never raw JSON.
export function renderPeopleUnavailable({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('People are unavailable', `<section class="narrow"><h1 class="hq">People are unavailable right now</h1><p class="lead">We could not load profiles on Unlinked this time. Nothing about your account or files has changed.</p><p><a class="button" href="">Try again</a> <a class="button sec" href="${csrf ? '/network' : '/'}">${csrf ? 'Back to your people' : 'Back to the home page'}</a></p></section>`, { accountLabel, displayName, csrf, importJob })
}

// Safety forms (removal requests, reports): one short form, a reason, optional
// details and an optional reply address. `values` re-fill the form after an error.
const SAFETY_STYLE = '<style>.unlinked-onboarding .safety-form fieldset{border:0;padding:0;margin:18px 0}.unlinked-onboarding .safety-form legend{font-size:14px;font-weight:600;margin-bottom:6px}.unlinked-onboarding .safety-form .choice{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-weight:400;font-size:16px}.unlinked-onboarding .safety-form .choice input{margin-top:5px;flex-shrink:0;width:18px;height:18px}.unlinked-onboarding .safety-form textarea{font:16px/1.5 inherit;font-family:inherit}.unlinked-onboarding .safety-form input[type=email]{display:block;width:100%;min-width:0;padding:12px 14px;margin-top:7px;border:1px solid var(--line2);border-radius:var(--r);background:#fff;color:var(--fg);font:inherit;font-size:16px}.unlinked-onboarding .safety-form .hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.unlinked-onboarding .safety-target{display:flex;gap:12px;align-items:center;margin:8px 0 4px}.unlinked-onboarding .safety-target .pav{width:44px;height:44px;font-size:16px;margin:0;border-width:0}</style>'
export const SAFETY_ERRORS = Object.freeze({ report_reason_required: 'Choose a reason.', report_details_required: 'Tell us a little more in the details box.', report_contact_invalid: 'That email address does not look right.', report_details_too_long: `Keep the details under ${DETAILS_MAX.toLocaleString('en-US')} characters.`, report_confirm_required: 'Please confirm the information is accurate.', report_target_invalid: 'This page is out of date. Go back and try again.' })
export const safetyError = code => SAFETY_ERRORS[code] ?? 'That did not work. Try again.'
const safetyForm = ({ action, csrf, reasons, values = {}, error, legend, signedIn, confirm, submit }) => `${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}<form class="safety-form" method="post" action="${html(action)}">${csrf ? csrfInput(csrf) : ''}<fieldset><legend>${html(legend)}</legend>${Object.entries(reasons).map(([value, label]) => `<label class="choice"><input type="radio" name="reason" value="${html(value)}" required${values.reason === value ? ' checked' : ''}><span>${html(label)}</span></label>`).join('')}</fieldset><label for="safety-details">Details <span class="small">(optional)</span><textarea id="safety-details" name="details" rows="4" maxlength="${DETAILS_MAX}" placeholder="What should we know?">${html(values.details)}</textarea></label><label for="safety-contact">Your email <span class="small">(optional, so we can reply${signedIn ? '; your sign-in address is included' : ''})</span><input id="safety-contact" type="email" name="contact" maxlength="254" autocomplete="email" value="${html(values.contact)}"></label><div class="hp" aria-hidden="true"><label for="safety-website">Leave empty</label><input id="safety-website" type="text" name="website" tabindex="-1" autocomplete="off"></div>${confirm ? `<label class="choice"><input type="checkbox" name="confirm" value="yes" required${values.confirm === 'yes' ? ' checked' : ''}><span>${html(confirm)}</span></label>` : ''}<button type="submit">${html(submit)}</button></form>`
const safetyTarget = profile => `<div class="safety-target">${profileFace(profile, ` tone-${HUES.indexOf(hue(raw(profile.id) || profile.name))}`)}<div><b>${html(profile.name)}</b>${profile.headline ? `<p class="small" style="margin:0">${html(profile.headline)}</p>` : ''}</div></div>`

// Report a person, a message or a conversation (docs/report-and-block.md).
// `target`: { name, headline?, profile? (public summary for the avatar) }.
export function renderReport({ accountLabel, displayName, csrf, importJob, kind = 'profile', target = {}, action, back, values, error, state = 'form', reference, blockHref = null, excerpt = null } = {}) {
  const chrome = csrf ? { accountLabel, displayName, csrf, importJob } : {}
  const who = html(target.name) || 'this person'
  const what = kind === 'message' ? `a message from ${who}` : kind === 'conversation' ? `your conversation with ${who}` : who
  const backLink = back ? `<p class="small"><a href="${html(back)}">← Back</a></p>` : ''
  if (state === 'done') return base('Report sent', `${SAFETY_STYLE}<section class="narrow"><h1 class="hq">Thanks for reporting</h1><p class="lead">A person will review your report about ${what}. We aim to review reports within 24 hours and remove content and accounts that break the <a href="/support#rules">community rules</a>.</p><div class="card"><p>Reference <b>${html(reference)}</b>. The person you reported is not told who reported them.</p>${blockHref ? `<p>Don’t want to hear from ${who}?</p><p><a class="button sec" href="${html(blockHref)}">Block ${who}</a></p>` : ''}</div><p><a class="button sec" href="${html(back || '/')}">Done</a></p></section>`, chrome)
  const quote = excerpt ? `<blockquote class="card sec small" style="margin:8px 0 0;white-space:pre-wrap">${html(excerpt)}</blockquote>` : ''
  return base('Report', `${SAFETY_STYLE}<section class="narrow">${backLink}<h1 class="hq">Report ${kind === 'profile' ? who : kind === 'message' ? 'a message' : 'a conversation'}</h1><p class="lead">Tell us what’s wrong. Reports are private: ${kind === 'profile' ? 'they' : who} won’t know who sent it.</p>${target.profile ? safetyTarget(target.profile) : kind !== 'profile' ? `<p class="small">${kind === 'message' ? 'From' : 'With'} <b>${who}</b></p>` : ''}${quote}${safetyForm({ action, csrf, reasons: REPORT_REASONS, values, error, legend: 'What’s the problem?', signedIn: Boolean(csrf), submit: 'Send report' })}<p class="small">In danger? Contact local emergency services first.</p></section>`, chrome)
}

// Confirm, and the result of, blocking someone (docs/report-and-block.md).
export function renderBlock({ accountLabel, displayName, csrf, importJob, name, action, back, state = 'confirm', error } = {}) {
  const chrome = { accountLabel, displayName, csrf, importJob }
  const who = html(name) || 'this person'
  if (state === 'done') return base('Blocked', `<section class="narrow"><h1 class="hq">You blocked ${who}</h1><p class="lead">They can’t message you or ask to connect, and you won’t see their messages. They are not told.</p><p>Changed your mind? Unblock them in <a href="/settings#blocked">Settings</a>.</p><p><a class="button sec" href="${html(back || '/network')}">Done</a> <a class="button quiet" href="/support#report">Report a problem</a></p></section>`, chrome)
  return base('Block', `<section class="narrow">${back ? `<p class="small"><a href="${html(back)}">← Back</a></p>` : ''}<h1 class="hq">Block ${who}?</h1>${error ? `<p class="notice error" role="alert">${html(error)}</p>` : ''}<ul><li>They can’t message you, and you won’t see messages from them. Your conversation is hidden.</li><li>They can’t ask to connect, and any connection between you is removed.</li><li>They are not told. You can unblock them anytime in Settings.</li></ul><form method="post" action="${html(action)}">${csrfInput(csrf)}<button class="danger" type="submit">Block ${who}</button> <a class="button quiet" href="${html(back || '/network')}">Cancel</a></form><p class="small">Something they did break the rules? Report it too: we review every report.</p></section>`, chrome)
}

// Ask Unlinked to remove a profile imported by members ("Not on Unlinked").
// Public: the person in it usually has no account (docs/removal-requests.md).
export function renderRemovalRequest({ accountLabel, displayName, csrf, importJob, profile = {}, state = 'form', values, error, reference } = {}) {
  const chrome = csrf ? { accountLabel, displayName, csrf, importJob } : {}
  const back = `<p class="small"><a href="${profilePath(raw(profile.id))}">← Back to the profile</a></p>`
  if (state === 'done') return base('Removal requested', `${SAFETY_STYLE}<section class="narrow"><h1 class="hq">Request received</h1><p class="lead">Thank you. We will review your request to remove ${html(profile.name) || 'this profile'} and remove it from Unlinked if it is about you or someone you act for.</p><div class="card"><p>Reference <b>${html(reference)}</b>. If you gave an email address, we will write to you there. Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p></div><p><a class="button sec" href="/">Back to Unlinked</a></p></section>`, chrome)
  if (state === 'member') return base('Request removal', `${SAFETY_STYLE}<section class="narrow">${back}<h1 class="hq">This person manages their own profile</h1><p class="lead">${html(profile.name) || 'They'} joined Unlinked, so only they can change or delete this profile.</p><p>If it is fake, impersonates you, or breaks the rules, report it from the profile’s ••• menu or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p></section>`, chrome)
  if (state === 'unavailable') return base('Request removal', `${SAFETY_STYLE}<section class="narrow">${back}<h1 class="hq">Request removal</h1><p class="lead">Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with this profile’s link and we will remove it.</p></section>`, chrome)
  return base('Request removal', `${SAFETY_STYLE}<section class="narrow">${back}<h1 class="hq">Request removal</h1><p class="lead">This profile was imported from members’ LinkedIn connections. The person in it has not joined Unlinked.</p>${safetyTarget(profile)}<p class="small">You don’t need an account. A person reviews every request, and we remove the profile and its connections from Unlinked.</p>${safetyForm({ action: `${profilePath(raw(profile.id))}/removal`, csrf, reasons: REMOVAL_REASONS, values, error, legend: 'Why should it be removed?', signedIn: Boolean(csrf), confirm: 'The information I give is accurate, and this profile is about me or someone I act for.', submit: 'Send removal request' })}</section>`, chrome)
}

// The iOS app shows only Unlinked members (docs/ios-app-directory.md).
export function renderProfileUnavailable({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('Profile not available', `<section class="narrow"><h1 class="hq">Profile not available</h1><p class="lead">This profile isn’t on Unlinked, or isn’t available in the app.</p><p>The app shows people who joined Unlinked${csrf ? ', and the people you imported yourself in <a href="/network">My Network</a>' : ''}.</p><p><a class="button sec" href="${csrf ? '/network' : '/people'}">Search people</a></p></section>`, csrf ? { accountLabel, displayName, csrf, importJob } : {})
}

// Help & support, public with or without a session (docs/support-and-legal.md).
// It is the App Store support URL: contact, account deletion, reporting,
// removal of an imported profile, community rules, and the Ideaflow policies.
export function renderSupport({ accountLabel, displayName, csrf, importJob } = {}) {
  const mail = `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>`
  return base('Help & support', `<section class="narrow support"><h1 class="hq">Help &amp; support</h1><p class="lead">Questions, a problem, or something that shouldn’t be here? Write to us. A person reads every message.</p>
<div class="card" id="contact"><h2>Contact us</h2><p>Email ${mail}. If it is about a profile or a conversation, include its link.</p><p>Ideas and bugs are welcome on the public <a href="${FEEDBACK_URL}" target="_blank" rel="noopener noreferrer">Unlinked feedback board ↗</a>.</p></div>
<div class="card" id="report"><h2>Report or block someone</h2><p><b>A profile:</b> open it, choose <b>•••</b>, then <b>Report</b> or <b>Block</b>.</p><p><b>A message:</b> hover or long-press it and choose <b>Report</b>. <b>A conversation:</b> open it, choose <b>⋯</b>, then <b>Report conversation</b> or <b>Block</b>.</p><p>Blocked people can’t message you or ask to connect, and they are not told. Unblock them in <a href="/settings#blocked">Settings → Blocked people</a>. You can also email ${mail}.</p></div>
<div class="card" id="removal"><h2>Remove a profile about you</h2><p>Some profiles on Unlinked were imported from members’ LinkedIn connections and are marked <b>Not on Unlinked</b>. If one is about you, open it and choose <b>Request removal</b>, or email ${mail} with its link. You don’t need an account. We remove the profile and its connections.</p></div>
<div class="card" id="delete-account"><h2>Delete your account</h2><ol><li>Sign in and open <a href="/settings#your-data">Settings</a> (Me → Settings &amp; agent setup).</li><li>Under <b>Your data</b>, open <b>Delete everything…</b></li><li>Type <b>delete everything</b> and choose <b>Permanently delete my data</b>.</li></ol><p class="small">This erases your imports, profile, connections, contact card and agent access, and removes you from People. To keep a copy, choose <b>Download everything</b> first. Your Ideaflow sign-in is shared with other Ideaflow apps; to close it as well, email ${mail}.</p></div>
<div class="card" id="rules"><h2>Community rules</h2><p>Unlinked has no tolerance for objectionable content or abusive users. Harassment, threats, hate, sexual content, spam, scams and impersonation are not allowed in profiles, messages, notes or connection requests.</p><p>We aim to review every report within 24 hours. We remove content that breaks these rules and the accounts that post it.</p></div>
<div class="card" id="legal"><h2>Privacy and terms</h2><p>Unlinked is made by Ideaflow, Inc. and follows Ideaflow’s <a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy ↗</a> and <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service ↗</a>.</p><p class="small">Unlinked is not affiliated with LinkedIn.</p></div></section>`, csrf ? { accountLabel, displayName, csrf, importJob } : {})
}

// "Data liberation": where to request a copy of your data from the
// big platforms (docs/data-liberation.md). Public, with or without a session.
// Every link is the vendor's own export page; Unlinked never sees those files.
export const DATA_EXPORTS = [
  { id: 'linkedin', name: 'LinkedIn', url: LINKEDIN_EXPORT, action: 'Request your LinkedIn export',
    what: 'Your profile, positions, education, skills, connections and messages, as spreadsheet (CSV) files in a ZIP.',
    how: 'Choose “Download larger data archive”. The connections file usually comes within minutes and the full archive within about a day. Download it within 72 hours of LinkedIn’s email.' },
  { id: 'facebook', name: 'Facebook', url: 'https://accountscenter.facebook.com/info_and_permissions/dyi', action: 'Download your Facebook information',
    what: 'Posts, photos and videos, comments, messages, friends and profile information.',
    how: 'In Meta’s Accounts Center choose <b>Download your information</b>, then your account, <b>All time</b> and a format (HTML to read, JSON to reuse). Large accounts can take hours to a few days; the files stay available for a few days.' },
  { id: 'instagram', name: 'Instagram and Threads', url: 'https://accountscenter.instagram.com/info_and_permissions/dyi/', action: 'Download your Instagram information',
    what: 'Photos, videos, stories, comments, messages, followers and who you follow.',
    how: 'The same Accounts Center flow as Facebook; Threads is included there too. Choose <b>All time</b> so nothing is left out.' },
  { id: 'google', name: 'Google', url: 'https://takeout.google.com/', action: 'Open Google Takeout',
    what: 'Gmail, Drive, Photos, Calendar, Contacts, YouTube, Maps history and more, product by product.',
    how: 'Large exports are split into several files and can take hours to days. Download links last a week. You can also schedule an export every two months for a year.' },
  { id: 'x', name: 'X (Twitter)', url: 'https://x.com/settings/download_your_data', action: 'Request your X archive',
    what: 'Your posts, direct messages, media, likes and account history, with a page to browse it offline.',
    how: 'X asks for your password and a verification code. It can take 24 hours or longer.' },
  { id: 'apple', name: 'Apple', url: 'https://privacy.apple.com/', action: 'Open Apple Data and Privacy',
    what: 'iCloud photos, contacts, calendars and notes, plus App Store, Apple Music and other activity.',
    how: 'Choose <b>Request a copy of your data</b>. Apple says it can take up to 7 days.' },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/setting/download-your-data', action: 'Download your TikTok data',
    what: 'Your profile, videos, comments, messages and activity.',
    how: 'Choose TXT to read or JSON to reuse. It is usually ready within a few days, and you have a few days to download it.' },
  { id: 'amazon', name: 'Amazon', url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html', action: 'Request your Amazon data',
    what: 'Order history, Alexa voice recordings, Kindle and other account activity.',
    how: 'Pick categories and confirm by email. Amazon says some requests take up to a month.' },
  { id: 'microsoft', name: 'Microsoft', url: 'https://account.microsoft.com/privacy', action: 'Open the Microsoft privacy dashboard',
    what: 'Search, browsing, location and voice activity linked to your Microsoft account.',
    how: 'In the privacy dashboard, use <b>Download your data</b>. Outlook mail and OneDrive files are saved from those apps.' },
]

export function renderDataLiberation({ accountLabel, displayName, csrf, importJob } = {}) {
  const external = value => `data-export-link href="${html(value.url)}" target="_blank" rel="noopener noreferrer"`
  const services = DATA_EXPORTS.map(value => `<article class="liberate-item" id="${value.id}"><div><h3>${html(value.name)}</h3><p>${value.what}</p><p class="small">${value.how}</p></div><a class="button sec sm" ${external(value)}>${html(value.action)} ↗</a></article>`).join('')
  const jump = [...DATA_EXPORTS.map(value => [value.id, value.name.replace(/ \(.*\)$/, '').replace(/ and .*$/, '')]), ['whatsapp', 'WhatsApp']].map(([id, name]) => `<a href="#${id}">${html(name)}</a>`).join('')
  const ownData = csrf ? '<a href="/settings#your-data">Settings → Your data → Download everything</a>' : '<b>Settings → Your data → Download everything</b> after you sign in'
  return base('Data liberation', `<section class="narrow wide liberate"><h1 class="hq">Data liberation</h1><p class="lead">Your profile, posts, photos and connections are yours. Every big platform will give you a copy if you ask. Here is where to ask, and what to expect.</p><nav class="liberate-jump" aria-label="Services on this page">${jump}</nav>
<div class="card" id="before"><h2>Before you start</h2><ul><li>Exports can include private messages, photos and contacts. Download them on your own computer and keep them somewhere safe.</li><li>Most arrive as a ZIP by email, and the download link expires after a few days. The file you save doesn’t expire.</li><li>When there is a choice, JSON is easiest to move into another app; HTML is easiest to read.</li></ul></div>
<div class="card liberate-list" id="services"><h2>Where to request your data</h2>${services}<article class="liberate-item" id="whatsapp"><div><h3>WhatsApp</h3><p>Your account details, and chats one at a time.</p><p class="small">There is no web page for this. In the app, <b>Settings → Account → Request account info</b> gives your account details in about 3 days. To keep a conversation, open it, tap the name, then <b>Export chat</b>.</p></div></article></div>
<div class="card" id="no-export-button"><h2>No export button?</h2><p>Ask for it. In the EU and UK, data protection law (GDPR) gives you the right to a copy of your personal data, and to the data you provided in a reusable format. In California, the CCPA gives you the right to know what a company has collected about you.</p><p>Email the company’s privacy contact, usually listed in its privacy policy, and ask for “a copy of all personal data you hold about me, in a machine-readable format.” Under GDPR they generally have a month to answer; under the CCPA, 45 days.</p></div>
<div class="card" id="bring-it-here"><h2>Bring LinkedIn to Unlinked</h2><p>Unlinked can import your LinkedIn export and rebuild your network here, with your connections searchable by you and your agents. <a href="/import-linkedin">How to import your LinkedIn export</a>.</p><p class="small">Your Unlinked data is yours too: ${ownData} gives you one file with everything.</p></div>
<p class="small">These links go to each company’s own pages, and the files go straight to you; Unlinked never receives them. Steps change from time to time; if one of these is out of date, <a href="/support">tell us</a>.</p></section>`, csrf ? { accountLabel, displayName, csrf, importJob } : {})
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
  return base('Bring your LinkedIn export', `<section class="narrow wide"><h1 class="hq">Bring your LinkedIn export</h1><p class="lead">Request your LinkedIn data export on the LinkedIn website, then import the ZIP after signing in.</p><div class="card sec"><h3>What to request</h3><p>A complete archive can include your profile, experience, education, skills and connections. Connections-only ZIP or CSV is also supported.</p>${exportSteps()}<p><a href="${LINKEDIN_EXPORT}" target="_blank" rel="noopener noreferrer">Request LinkedIn export ↗</a></p><p class="small">Exports from Facebook, Google and others: <a href="/data-liberation">Data liberation</a>.</p></div><div class="card sec"><h3>What happens next</h3><p>Maximum archive size: 64 MiB. Processing continues on the server after you leave the page; return to Profile or People for progress. Search and agent setup use your own account’s published records.</p><div class="actions">${csrf ? '<a class="button sm" href="/import">Import my file</a>' : '<a class="button sm" href="/login?next=%2Fimport">Sign in and import</a>'}<a class="button sec sm" href="${csrf ? '/network' : '/people'}">Explore people</a></div></div></section>`, { accountLabel, displayName, csrf, importJob })
}

// The controls keep their ids; the controller attaches the scanner script with its own nonce.
// Nothing opens, and no contact or access changes, until the person presses Open.
// The camera scanner, shared by /meet and the Scan tab of /scan (same element
// ids, so MEET_SCRIPT drives both). If the camera is unavailable or declined,
// the script opens the paste box and says how to allow the camera; "Scan from
// photo" reads a QR code from a picture or screenshot (on iPhone: the photo
// library). Every result stops at the visible confirm step.
const scanPanel = () => `<div class="scan-cam"><div id="camera"></div><div class="scan-frame" aria-hidden="true"></div><p class="scan-hint">Point your camera at an Unlinked, LinkedIn or OpenChat QR code</p></div><p id="status" class="small" role="status" aria-live="polite"></p><div id="confirm" class="notice" hidden><p>Scanned: <b id="confirm-label"></b></p><p class="small">Open it to continue. LinkedIn codes find the person on Unlinked. Nothing is added or sent.</p><div class="actions"><a id="confirm-open" class="button sm" href="/meet">Open</a><button id="confirm-cancel" type="button" class="quiet sm">Cancel</button></div></div><div class="actions"><button id="start" type="button" class="sm">Start camera</button><button id="stop" type="button" class="quiet sm">Stop camera</button><label class="button sec sm scan-photo" for="scan-photo">Scan from photo</label><input id="scan-photo" class="vh" type="file" accept="image/*"></div><details class="scan-paste"><summary>Paste a link instead</summary><form id="paste"><label for="card-url">Card or profile link</label><input id="card-url" type="text" inputmode="url" autocapitalize="off" spellcheck="false" required><div class="actions"><button class="quiet sm">Check link</button></div></form></details><p class="small">Nothing opens until you confirm, and scanning never adds a contact or grants access by itself.</p>`
export function renderMeet({ accountLabel, displayName, csrf, importJob } = {}) {
  return base('Meet someone', `<section class="narrow scan-sheet"><h1 class="hq">Meet someone</h1><p class="lead">Scan an Unlinked, LinkedIn profile, or OpenChat card, or paste its link. You confirm what was scanned before anything opens; scanning never adds a contact or grants access by itself.</p>${scanPanel()}</section>`, { accountLabel, displayName, csrf, importJob, signInNext: '/meet' })
}

// The scan sheet behind the search bar's QR button: My card (the member's own
// business card and QR, the default for members) and Scan (the /meet camera
// flow, same element ids and the same explicit confirm). Tabs are links, so either tab works without script; the
// page script switches them in place, stops the camera when it is hidden and
// starts it when Scan is shown. Signed-out visitors can scan; their My card
// tab offers sign-in instead.
export function renderScan({ accountLabel, displayName, csrf, importJob, tab, profile, cardUrl, qr, contact = null } = {}) {
  // Members meet people in person, so the QR button opens their own card (and its
  // QR) first; ?tab=scan opens the camera. Visitors have no card yet: Scan first.
  const onCard = tab === 'card' || (tab !== 'scan' && Boolean(csrf))
  const tabLink = (id, href, label, selected) => `<a role="tab" id="tab-${id}" href="${href}" aria-controls="panel-${id}" aria-selected="${selected}"${selected ? '' : ' tabindex="-1"'}>${label}</a>`
  // A member's contact card (every member has one from day one) is the code to show; the public profile QR otherwise.
  const contactLive = Boolean(contact?.card && contact.qr && contact.shareUrl)
  const cardPanel = csrf
    ? contactLive
      ? `${businessCard({ name: contact.card.name || profile?.name, headline: contact.card.headline, location: contact.card.location, photo: profile?.photo, heading: 'h2', qrFirst: true, rows: contactRows(contact.card), side: `<div class="qr">${contact.qr}</div><p class="small">Scan to save my contact and connect</p>` })}<div class="actions"><a class="button sm" href="/card">Open full card</a><a class="button sec sm" href="/profile">View profile</a></div>`
      : cardFace({ profile, cardUrl, qr, heading: 'h2', actions: `<a class="button sm" href="/card">Open full card</a><a class="button sec sm" href="/profile">View profile</a>` })
    : `<div class="card"><h2>Your card</h2><p>Members get a QR code to show when they meet someone: it saves their contact and connects you.</p><div class="actions"><a class="button sm" href="/login?next=%2Fcard">Sign in to show your card</a><a class="button sec sm" href="/join">Join Unlinked</a></div></div>`
  return { camera: true, ...base('Scan', `<section class="narrow scan-sheet"><div class="sheet-top"><h1 class="hq">Scan or share</h1><a class="sheet-close" href="${csrf ? '/network' : '/'}" aria-label="Close">×</a></div><div class="tabs" role="tablist" aria-label="Scan a code or show your card">${csrf ? tabLink('card', '/scan?tab=card', 'My card', onCard) + tabLink('scan', '/scan?tab=scan', 'Scan', !onCard) : tabLink('scan', '/scan?tab=scan', 'Scan', !onCard) + tabLink('card', '/scan?tab=card', 'My card', onCard)}</div><div class="tabpanel" role="tabpanel" id="panel-scan" aria-labelledby="tab-scan"${onCard ? ' hidden' : ''}>${scanPanel()}</div><div class="tabpanel" role="tabpanel" id="panel-card" aria-labelledby="tab-card"${onCard ? '' : ' hidden'}>${cardPanel}</div></section>`, { accountLabel, displayName, csrf, importJob, signInNext: '/scan' }) }
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
const profileHref = id => html(`${profilePath(raw(id))}`)
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

// `who` is the rendered name: a link to their profile when they have one.
const NOTIFICATION_TEXT = {
  connection_request_received: who => `${who} wants to connect with you`,
  connection_request_accepted: who => `${who} accepted your invitation to connect`,
  invite_accepted: who => `${who} accepted your invite and joined Unlinked. You are now connected.`,
  profile_claimed: who => `${who}, someone in your connections, joined Unlinked and claimed their profile`,
}
// The notification feed. `pending` maps request ids that still await an answer,
// so a request notification can be answered in place; `connected` holds request
// ids that are now connections (accepted, or added through a contact card), so
// an answered request says so instead of still asking.
export function renderNotifications({ accountLabel, displayName, csrf, importJob, items = [], pending = new Map(), connected = new Set(), pendingCount = 0, now = Date.now(), notice, emailEnabled = false } = {}) {
  const rows = list(items).filter(value => NOTIFICATION_TEXT[value.kind]).map(value => {
    // The whole row opens the item (and marks it read); the name and photo open
    // the person's profile, through the same route so they mark it read too.
    const request = value.kind === 'connection_request_received'
    const waiting = request && pending.has(value.subjectId)
    const done = request && !waiting && connected.has(value.subjectId)
    // People without a public profile (e.g. joined from a card scan) open
    // their private contact page instead, once they are a connection.
    const contact = !value.actorProfileId && (value.kind === 'invite_accepted' || ((request || value.kind === 'connection_request_accepted') && connected.has(value.subjectId)))
    const toProfile = value.actorProfileId || contact ? html(`/notifications/${value.id}?to=profile`) : null
    const who = toProfile ? `<a class="note-person" href="${toProfile}"><b>${html(value.actorName)}</b></a>` : `<b>${html(value.actorName)}</b>`
    const face = avatar(value.actorName, value.actorProfileId ?? value.actorName)
    const text = done ? `${who} is now connected with you` : NOTIFICATION_TEXT[value.kind](who)
    return `<li class="note${value.read ? '' : ' unread'}"><div class="note-row">${toProfile ? `<a class="note-face" href="${toProfile}" tabindex="-1" aria-hidden="true">${face}</a>` : face}<span class="note-text">${text}${value.read ? '' : '<span class="vh"> (unread)</span>'}<span class="small note-time"><a class="note-open" href="/notifications/${html(value.id)}">${html(ago(value.createdAt, now))}<span class="vh"> · open notification</span></a>${done ? ' · <span class="note-state">Connected</span>' : ''}</span></span></div>${waiting ? respondForm(csrf, value.subjectId, '/notifications') : ''}</li>`
  }).join('')
  const unread = list(items).some(value => !value.read)
  const summary = pendingCount > 0 ? `<a class="note-summary" href="/invitations">${NETWORK_NAV_ICON}<span><b>${count(pendingCount)} pending ${pendingCount === 1 ? 'invitation' : 'invitations'}</b><span class="small">Review them in My Network</span></span></a>` : ''
  return base('Notifications', `<section class="narrow wide notes"><div class="notes-top"><h1 class="hq">Notifications</h1>${unread ? `<form method="post" action="/notifications/read-all">${csrfInput(csrf)}<button class="quiet sm" type="submit">Mark all as read</button></form>` : ''}</div>${Object.hasOwn(CONNECT_NOTICES, raw(notice)) ? `<p class="notice" role="status">${html(CONNECT_NOTICES[notice])}</p>` : ''}${summary}<div class="card">${rows ? `<ul class="note-list">${rows}</ul>` : '<p class="small empty">Nothing yet. Invitations to connect, people accepting yours, and people you know joining Unlinked show up here.</p>'}</div><p class="small">${emailEnabled ? 'Email notifications follow your <a href="/settings#email">email preferences</a>. Requests you have already seen here are not emailed.' : 'Notifications appear here. Email delivery is currently unavailable.'}</p></section>`, { accountLabel, displayName, csrf, importJob })
}

// The conversation list column, shared by the Messages page and the dock.
const messagesSide = ({ available = true, heading = 'h1' } = {}) => `<aside class="msg-side" aria-label="Conversations"><div class="msg-side-head"><${heading} class="msg-title">Messages</${heading}><span id="msg-live" class="msg-live" role="status" hidden></span>${available ? '<button id="msg-new" class="button sm" type="button">New message</button>' : ''}</div><div class="msg-search"><input id="msg-filter" type="search" placeholder="Search messages" aria-label="Filter conversations; press Enter to search all messages (press / to focus)" autocomplete="off" aria-keyshortcuts="/"><button id="msg-unread-first" class="msg-toggle" type="button" aria-pressed="false" title="Show unread conversations first">Unread first</button></div><p id="msg-announce" class="vh" aria-live="polite"></p><p id="msg-status" class="msg-status" role="status" hidden></p><ul id="msg-list" class="msg-list" role="list" aria-label="Conversations">${available ? '<li class="msg-list-empty">Loading…</li>' : ''}</ul></aside>`

// The native Messages shell (docs/openchat-message.md): the list and thread are
// filled by the page script from /messages/api; OpenChat stays the store.
// `entry` is a profile Message link that did not open a conversation.
export function renderMessages({ accountLabel, displayName, csrf, conversationId = null, entry = null, available = true } = {}) {
  const retry = entry?.profile ? `/messages?profile=${encodeURIComponent(entry.profile)}` : '/messages'
  const notice = !available ? '<div class="msg-empty"><h2>Messages are unavailable right now</h2><p class="small">Your conversations are safe in OpenChat. <a href="https://chat.ideaflow.app/app/" target="_blank" rel="noopener noreferrer">Open OpenChat ↗</a></p></div>'
    : entry?.status === 'unclaimed' ? `<div class="msg-empty"><span class="initials avatar" aria-hidden="true">${html(initials(entry.name)) || '·'}</span><h2>${entry.name ? `${html(entry.name)} is n` : 'N'}ot on Unlinked yet</h2><p class="small">Invite them to join, then message them here.</p><p><a class="button" href="/invites">Invite to Unlinked</a></p></div>`
    : entry?.status === 'blocked' ? `<div class="msg-empty"><h2>You blocked ${html(entry.name) || 'this person'}</h2><p class="small">Unblock them in Settings to message them again.</p><p><a class="button sec" href="/settings#blocked">Blocked people</a></p></div>`
    : entry ? `<div class="msg-empty"><h2>We couldn’t open this conversation</h2><p class="small">This person may not be available for messages right now.</p><p><a class="button sec" href="${html(retry)}">Try again</a> <a class="button quiet" href="/messages">All messages</a></p></div>`
    : '<div class="msg-empty"><p>Select a conversation</p><p class="small">Or message someone from <a href="/network">People</a>.</p></div>'
  return base('Messages', `<section class="msg"><div class="msg-app" id="msg-app"${conversationId ? ` data-open="${html(conversationId)}" data-conversation="${html(conversationId)}"` : ''}>${messagesSide({ available })}<section class="msg-thread" id="msg-thread" aria-label="Conversation">${notice}</section></div><noscript><p>Messages needs JavaScript. <a href="https://chat.ideaflow.app/app/">Open OpenChat ↗</a></p></noscript></section>`, { accountLabel, displayName, csrf })
}

// The desktop dock on other signed-in pages (≥ 1024 px): a collapsed bar that
// opens the same client in a small panel. Shown by the script; hidden without it.
export const renderMessagesDock = () => `<aside class="msg-dock" id="msg-dock" aria-label="Messaging" hidden data-expanded="false"><button id="msg-dock-toggle" class="msg-dock-bar" type="button" aria-expanded="false" aria-controls="msg-dock-panel"><span>Messaging</span><span id="msg-dock-count" class="msg-pill" hidden></span><span class="msg-dock-caret" aria-hidden="true"></span></button><div id="msg-dock-panel" class="msg-dock-panel" hidden><div class="msg-app" id="msg-app">${messagesSide({ heading: 'h2' })}<section class="msg-thread" id="msg-thread" aria-label="Conversation"><div class="msg-empty"><p>Select a conversation</p></div></section></div><a class="msg-dock-full small" href="/messages">Open Messages ↗</a></div></aside>`

// ── Signed-in Home (unlinked-5e5, docs/member-home.md) ───────────────────────
// `summary` comes from summarizeImports (src/utils/private-import/import-summary.mjs):
// real upload jobs plus the files recovered from a member's original Unlinked
// account. Nothing here claims an import that the summary does not report.
const HOME_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const homeDate = ms => Number.isSafeInteger(ms) && ms > 0 ? `<time datetime="${new Date(ms).toISOString()}">${HOME_DATE.format(ms)}</time>` : ''
const plural = (value, one, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`
// One plain sentence naming the import that stands (used on Home and /import).
export function importLine(summary) {
  const done = summary?.lastComplete
  if (!done) return ''
  if (done.source === 'recovered') return `Your LinkedIn import has ${plural(done.connections, 'connection')}${done.at ? `, uploaded ${HOME_DATE.format(done.at)} to your original Unlinked account` : ' from your original Unlinked account'}.`
  return `Your LinkedIn import has ${plural(done.records, 'record')}${done.at ? `, imported ${HOME_DATE.format(done.at)}` : ''}.`
}
const recoveredFacts = value => [value.profile ? 'profile' : '', value.positions ? plural(value.positions, 'position') : '', value.education ? plural(value.education, 'education entry', 'education entries') : '', value.skills ? plural(value.skills, 'skill') : ''].filter(Boolean)
const statePill = (label, tone) => `<span class="home-pill ${tone}">${label}</span>`
function importCard(summary, { csrf, reminderDismissed, reminderControl }) {
  const head = (pill) => `<div class="home-card-head"><h2>LinkedIn import</h2>${pill}</div>`
  const attention = summary.attention ? `<p class="notice error" role="status">Your upload${summary.attention.at ? ` on ${homeDate(summary.attention.at)}` : ''} ${summary.attention.status === 'partial' ? 'only partly imported' : 'could not be imported'}.${summary.attention.errorMessage ? ` ${html(summary.attention.errorMessage)}` : ''} <a href="/import">Try again</a></p>` : ''
  const more = '<p class="home-links small"><a href="/settings">Import details</a><a class="quiet-link" href="/import">Upload a newer export</a></p>'
  if (summary.state === 'in_progress') {
    // Live progress is the page's import banner, which refreshes itself.
    const job = summary.active?.job ?? {}
    return `<section class="card home-card" aria-label="LinkedIn import">${head(statePill('Importing', 'busy'))}<p>Reading your file${summary.active?.at ? ` (uploaded ${homeDate(summary.active.at)})` : ''}. Progress shows at the top of the page, and the import keeps running if you leave.</p>${job.profileReady ? '<p class="small">Your profile is ready; connections are still coming in.</p>' : ''}${summary.lastComplete ? `<p class="small">${html(importLine(summary))}</p>` : ''}</section>`
  }
  if (summary.state === 'complete') {
    const done = summary.lastComplete
    const facts = done.source === 'recovered'
      ? `<p><b>${plural(done.connections, 'connection')}</b>${recoveredFacts(done).length ? ` · ${recoveredFacts(done).join(', ')}` : ''}</p><p class="small">${done.at ? `Uploaded ${homeDate(done.at)} to your original Unlinked account` : 'From your original Unlinked account'}, and recovered to this account.${done.skipped ? ` ${plural(done.skipped, 'row')} had no name or LinkedIn address and ${done.skipped === 1 ? 'was' : 'were'} skipped.` : ''}</p>`
      : `<p><b>${plural(done.records, 'record')}</b> imported${done.at ? ` ${homeDate(done.at)}` : ''}.</p>${done.skipped ? `<p class="small">${plural(done.skipped, 'row')} had no name or LinkedIn address and ${done.skipped === 1 ? 'was' : 'were'} skipped.</p>` : ''}`
    return `<section class="card home-card" aria-label="LinkedIn import">${head(statePill('Complete', 'ok'))}${facts}${attention}${more}</section>`
  }
  if (summary.state === 'partial' || summary.state === 'failed') {
    const label = summary.state === 'partial' ? 'Needs attention' : 'Not imported'
    const message = summary.attention?.errorMessage ?? (summary.state === 'partial' ? 'Some of your file could not be read.' : 'Your file could not be imported.')
    return `<section class="card home-card" aria-label="LinkedIn import">${head(statePill(label, 'warn'))}<p role="status">${html(message)}</p>${summary.attention?.at ? `<p class="small">Uploaded ${homeDate(summary.attention.at)}.</p>` : ''}<div class="actions"><a class="button sm" href="/import">Try another file</a><a class="button sec sm" href="/settings">Import details</a></div></section>`
  }
  if (summary.state === 'unknown') return `<section class="card home-card" aria-label="LinkedIn import">${head(statePill('Unavailable', 'muted'))}<p role="status">Your import status can’t be checked right now. Refresh in a minute; nothing about your files has changed.</p></section>`
  // No import yet, and the member hid the getting-started reminder.
  const show = reminderControl && reminderDismissed ? `<form class="reminder-hide" method="post" action="/home/import-reminder">${csrfInput(csrf)}<input type="hidden" name="reminder" value="shown"><button class="link-button" type="submit">Show the setup guide on Home</button></form>` : ''
  return `<section class="card home-card" aria-label="LinkedIn import">${head(statePill('Not yet', 'muted'))}<p>No LinkedIn export imported yet. It brings your connections and fills in your profile.</p><div class="actions"><a class="button sm" href="/import">Import my file</a></div>${show}</section>`
}
const waiting = alerts => [
  Number.isSafeInteger(alerts?.network) && alerts.network > 0 ? `<a class="home-row" href="/invitations"><b>${plural(alerts.network, 'connection request')}</b><span>Review →</span></a>` : '',
  Number.isSafeInteger(alerts?.notifications) && alerts.notifications > 0 ? `<a class="home-row" href="/notifications"><b>${plural(alerts.notifications, 'new notification')}</b><span>Open →</span></a>` : '',
  Number.isSafeInteger(alerts?.messages) && alerts.messages > 0 ? `<a class="home-row" href="/messages"><b>${plural(alerts.messages, 'unread message')}</b><span>Read →</span></a>` : '',
].join('')
export function renderMemberHome({ accountLabel, displayName, csrf, importJob, summary, recent, networkSize, alerts, reminderDismissed = false, reminderControl = false }) {
  const first = raw(displayName).trim().split(/\s+/)[0]
  const name = first && !first.includes('@') && !/^[0-9a-f-]{20,}$/i.test(first) ? `, ${html(first)}` : ''
  const people = list(recent)
  const inbox = waiting(alerts)
  const size = Number.isSafeInteger(networkSize) && networkSize > 0 ? networkSize : null
  const recentCard = people.length
    ? `<section class="card home-card" aria-labelledby="home-recent"><div class="home-card-head"><h2 id="home-recent">Recently connected</h2>${size ? `<a class="small" href="/network">${plural(size, 'person', 'people')} in your network</a>` : ''}</div>${people.map(person => `${connectionRow(person)}${homeDate(person.connectedAt) ? `<p class="small home-when">Connected ${homeDate(person.connectedAt)}</p>` : ''}`).join('')}<p class="small"><a href="/network?connected=1&amp;sort=connected">See everyone by date connected →</a></p></section>`
    : size ? `<section class="card home-card" aria-label="Your network"><div class="home-card-head"><h2>Your network</h2></div><p><b>${plural(size, 'person', 'people')}</b> you know are on Unlinked or in your import.</p><p class="small"><a href="/network">Browse your people →</a></p></section>` : ''
  const lead = summary?.state === 'complete' ? 'Search the people you know, or pick up where you left off.' : summary?.state === 'in_progress' ? 'Your import is running. You can explore while it finishes.' : 'Explore people on Unlinked, and bring your LinkedIn export when it’s ready.'
  return base('Home', `<section class="home"><div class="home-head"><h1 class="hq">Welcome back${name}</h1><p class="lead">${lead}</p><form class="home-search" method="get" action="/network" role="search"><label class="sr-only" for="home-q">Search people</label><input id="home-q" name="q" type="search" maxlength="200" enterkeyhint="search" placeholder="Search by name, role or company"><button type="submit">Search</button></form></div><div class="home-grid"><div class="home-main">${inbox ? `<section class="card home-card" aria-label="Waiting for you"><div class="home-card-head"><h2>Waiting for you</h2></div>${inbox}</section>` : ''}${recentCard}${!inbox && !recentCard ? '<section class="card home-card" aria-label="Explore"><div class="home-card-head"><h2>Explore</h2></div><p>Find people by name, role or company, and connect with members you know.</p><p class="small"><a href="/network">Explore people →</a></p></section>' : ''}</div><aside class="home-side">${importCard(summary ?? { state: 'none' }, { csrf, reminderDismissed, reminderControl })}<section class="card home-card" aria-label="You"><div class="home-card-head"><h2>You</h2></div><a class="home-row" href="/profile"><b>Your profile</b><span>View →</span></a><a class="home-row" href="/card"><b>My card</b><span>Share →</span></a><a class="home-row" href="/settings"><b>Connect your agent</b><span>Set up →</span></a></section></aside></div></section>`, { accountLabel, displayName, csrf, importJob, statusBanner: summary?.state === 'in_progress' })
}
