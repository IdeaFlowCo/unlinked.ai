import test from 'node:test'
import assert from 'node:assert/strict'
import { analyticsTag, queueAnalyticsEvent, takeAnalyticsEvents } from '../mcp-server/ideaflow-analytics.mjs'

test('signed-out pages carry only the nonce-bound analytics tag', () => {
  const tag = analyticsTag('n0nce')
  assert.equal(tag, '<script nonce="n0nce" defer src="https://analytics.ideaflow.app/ideaflow.js" data-product="unlinked"></script>')
})

test('signed-in pages identify by subject only, escape it, and emit queued one-shot events', () => {
  const session = {}
  queueAnalyticsEvent(session, 'signup')
  queueAnalyticsEvent(session, 'activated')
  queueAnalyticsEvent(session, 'not-an-event')
  const tag = analyticsTag('n0nce', { subject: 'sub</script><x>', events: takeAnalyticsEvents(session) })
  assert.match(tag, /a\.identify\(s\)/)
  assert.ok(tag.includes('"sub\\u003c/script>\\u003cx>"'))
  assert.ok(!tag.includes('</script><x>'))
  assert.ok(tag.includes('["signup","activated"]'))
  assert.deepEqual(takeAnalyticsEvents(session), [])
})
