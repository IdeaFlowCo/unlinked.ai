import test from 'node:test'
import assert from 'node:assert/strict'
import { analyticsTag, queueAnalyticsEvent, takeAnalyticsEvents } from '../mcp-server/ideaflow-analytics.mjs'

test('signed-out pages carry only the nonce-bound analytics tag', () => {
  const tag = analyticsTag('n0nce')
  assert.equal(tag, '<script nonce="n0nce" async src="https://analytics.ideaflow.app/ideaflow.js" data-product="unlinked" data-respect-dnt="true" data-privacy="strict"></script>')
})

test('signed-in analytics never render account identity or queued event data', () => {
  const session = {}
  queueAnalyticsEvent(session, 'signup')
  queueAnalyticsEvent(session, 'activated')
  queueAnalyticsEvent(session, 'not-an-event')
  const tag = analyticsTag('n0nce', { subject: 'private-subject</script><x>', events: takeAnalyticsEvents(session) })
  assert.equal(tag, analyticsTag('n0nce'))
  assert.ok(!tag.includes('private-subject'))
  assert.ok(!tag.includes('identify'))
  assert.ok(!tag.includes('localStorage'))
  assert.deepEqual(takeAnalyticsEvents(session), [])
})
