// World Issue Tracker's existing, URL-bound Unlinked.ai board.
// Keep the hosted loader so widget fixes reach Unlinked without a redeploy.
export const FEEDBACK_WIDGET_SITE = 'https://worldissuetracker.com'
export const FEEDBACK_WIDGET_SCRIPT = `${FEEDBACK_WIDGET_SITE}/widget/wit-feedback.js`
export const FEEDBACK_WIDGET_API = 'https://qmzopiburflputowkuhu.supabase.co'
export const feedbackWidgetTag = nonce => `<script nonce="${nonce}" src="${FEEDBACK_WIDGET_SCRIPT}" data-tracker-slug="unlinked-ai" data-theme="auto" defer></script>`
