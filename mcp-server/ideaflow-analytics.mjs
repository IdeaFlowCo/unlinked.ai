// Anonymous pageviews only; never render account subjects or queued event properties.
export const ANALYTICS_ORIGIN = 'https://analytics.ideaflow.app'
export const ANALYTICS_SCRIPT = `${ANALYTICS_ORIGIN}/ideaflow.js`
const EVENTS = new Set(['signup', 'activated'])

export function analyticsTag(nonce) {
  return `<script nonce="${nonce}" defer src="${ANALYTICS_SCRIPT}" data-product="unlinked" data-respect-dnt="true" data-privacy="strict"></script>`
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
