// Ideaflow product analytics: the self-hosted Umami wrapper at analytics.ideaflow.app
// (product slug "unlinked"). Pageviews are automatic; a signed-in page identifies the
// browser by the Ideaflow ID subject only (never an email or name). One-shot events
// (signup, activated) are queued on the in-memory session and emitted on the next page.
export const ANALYTICS_ORIGIN = 'https://analytics.ideaflow.app'
export const ANALYTICS_SCRIPT = `${ANALYTICS_ORIGIN}/ideaflow.js`
const EVENTS = new Set(['signup', 'activated'])
// Inline data is JSON in a nonce'd script; escape '<' so no value can close the tag.
const inline = value => JSON.stringify(value).replace(/</g, '\\u003c')

export function analyticsTag(nonce, { subject = null, events = [] } = {}) {
  const tag = `<script nonce="${nonce}" defer src="${ANALYTICS_SCRIPT}" data-product="unlinked"></script>`
  const sub = typeof subject === 'string' && subject ? subject.slice(0, 200) : null
  const queued = events.filter(event => EVENTS.has(event))
  if (!sub) return tag
  // Deferred scripts run before DOMContentLoaded, so window.ideaflow exists by then.
  // `activated` is sent at most once per person per browser.
  return `${tag}<script nonce="${nonce}">document.addEventListener('DOMContentLoaded',function(){var a=window.ideaflow;if(!a)return;var s=${inline(sub)},e=${inline(queued)};a.identify(s);e.forEach(function(n){if(n==='activated'){var k='ul-analytics-activated:'+s;try{if(localStorage.getItem(k))return;localStorage.setItem(k,'1')}catch(x){return}a.track(n)}else a.track(n,{method:'ideaflow'})})})</script>`
}

// Read and clear a session's queued one-shot events.
export function takeAnalyticsEvents(session) {
  if (!session || !Array.isArray(session.analyticsEvents) || !session.analyticsEvents.length) return []
  const events = session.analyticsEvents
  session.analyticsEvents = []
  return events
}
export function queueAnalyticsEvent(session, event) {
  if (!session || !EVENTS.has(event)) return
  session.analyticsEvents = [...(Array.isArray(session.analyticsEvents) ? session.analyticsEvents : []), event].slice(-4)
}
