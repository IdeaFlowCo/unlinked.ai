// World Issue Tracker's existing, URL-bound Unlinked.ai board.
// Keep the hosted loader so widget fixes reach Unlinked without a redeploy.
export const FEEDBACK_WIDGET_SITE = 'https://worldissuetracker.com'
export const FEEDBACK_WIDGET_SCRIPT = `${FEEDBACK_WIDGET_SITE}/widget/wit-feedback.js`
export const FEEDBACK_WIDGET_API = 'https://api.worldissuetracker.com'
// world-issue-tracker-uonq (design review Option A): the widget used to
// render a position:fixed floating circular bubble, which on mobile sat on
// top of the page's own primary CTA (e.g. the landing page's "Create my
// profile" button). data-mount-selector points the widget's wit-core.js at
// #wit-feedback-slot — a plain span already in private-onboarding-views.mjs's
// shared footer() — so it renders an inline text-link trigger there instead.
// If that slot isn't in the DOM (e.g. an iOS wrapper view that never calls
// footer()), wit-core.js falls back to the classic floating bubble exactly
// as before; this is purely additive on the widget side.
export const feedbackWidgetTag = nonce => `<script nonce="${nonce}" src="${FEEDBACK_WIDGET_SCRIPT}" data-tracker-slug="unlinked-ai" data-mount-selector="#wit-feedback-slot" data-theme="auto" defer></script>`
