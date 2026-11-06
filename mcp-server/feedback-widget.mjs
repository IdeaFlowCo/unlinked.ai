import { readFileSync } from 'node:fs'

// World Issue Tracker in-app feedback, menu-launched and identity-verified
// (WIT docs/widget-host-integration-guide.md#menu-launched-identity-verified-install).
// Keep the hosted loader so widget fixes reach Unlinked without a redeploy.
export const FEEDBACK_WIDGET_SITE = 'https://worldissuetracker.com'
export const FEEDBACK_WIDGET_SCRIPT = `${FEEDBACK_WIDGET_SITE}/widget/wit-feedback.js`
export const FEEDBACK_WIDGET_API = 'https://api.worldissuetracker.com'
// Screenshot attachments upload by signed PUT straight to WIT's GCS bucket.
export const FEEDBACK_UPLOAD_ORIGIN = 'https://storage.googleapis.com'
export const FEEDBACK_TRACKER_SLUG = 'unlinked-feedback'
export const FEEDBACK_TOKEN_PATH = '/wit-feedback-token'
const FEEDBACK_TOKEN_EXCHANGE = `${FEEDBACK_WIDGET_API}/functions/v1/feedback-token`
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// The iOS app (a plain WKWebView with no script bridge, user agent
// `UnlinkediOS/<CFBundleShortVersionString>`) gets the same menu-launched
// widget, labelled with the installed app version so reports say which build
// they came from (world-issue-tracker-julr.11).
const IOS_APP_VERSION = /\bUnlinkediOS\/([0-9][0-9A-Za-z.-]{0,31})/
export const iosAppVersion = userAgent => (typeof userAgent === 'string' && userAgent.length <= 1024 && IOS_APP_VERSION.exec(userAgent)?.[1]) || null

// No launcher at all (data-trigger="none"): the widget opens only from the
// "Send feedback" items (Me menu, footer) via FEEDBACK_MENU_SCRIPT.
export const feedbackWidgetTag = (nonce, { iosApp = null } = {}) => {
  const app = iosApp ? 'Unlinked iOS' : 'Unlinked'
  const version = iosApp ? `${iosApp} (web ${APP_VERSION})` : APP_VERSION
  return `<script nonce="${nonce}" src="${FEEDBACK_WIDGET_SCRIPT}" data-tracker-slug="${FEEDBACK_TRACKER_SLUG}" data-trigger="none" data-app="${attr(app)}" data-app-version="${attr(version)}" data-theme="auto" defer></script>`
}

// Runs under each page's nonce, before the deferred loader: calls go through
// the documented __witFeedbackQueue. Signed-in pages (the Me menu is present)
// give the widget a token getter; the server returns a short-lived wfb1.
// feedback token or 204 (anonymous). Pages without the widget send the item
// to /support instead of a panel that never loads.
export const FEEDBACK_MENU_SCRIPT = `(()=>{const wf=(m,...a)=>{if(window.WitFeedback)return window.WitFeedback[m](...a);(window.__witFeedbackQueue||=[]).push([m,a])};if(document.querySelector('details.me')){let c=null;wf('setUserToken',async()=>{if(c&&c.expires_at*1000-Date.now()>60000)return c.token;try{const r=await fetch('${FEEDBACK_TOKEN_PATH}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'});c=r.status===200?await r.json():null}catch{c=null}return c?.token??null})}document.addEventListener('click',e=>{const b=e.target.closest?.('[data-wit-feedback]');if(!b)return;e.preventDefault();const me=b.closest('details.me');if(me)me.open=false;if(!window.WitFeedback&&!document.querySelector('script[data-tracker-slug]')){location.href='/support';return}wf('open')})})();`

// Server side of the exchange: the signed-in member's Ideaflow ID token (held
// only in the in-memory session) becomes a 15-minute token that can only file
// issues. Never throws; any failure means anonymous feedback.
export async function exchangeFeedbackToken(idToken, { fetchImpl = fetch } = {}) {
  if (typeof idToken !== 'string' || !idToken) return null
  try {
    const response = await fetchImpl(FEEDBACK_TOKEN_EXCHANGE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken, app: 'unlinked' }), signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const value = await response.json()
    if (typeof value?.token !== 'string' || !value.token.startsWith('wfb1.') || !Number.isSafeInteger(value.expires_at)) return null
    return { token: value.token, expires_at: value.expires_at }
  } catch { return null }
}
