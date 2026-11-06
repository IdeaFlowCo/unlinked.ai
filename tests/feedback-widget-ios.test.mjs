import test from 'node:test'
import assert from 'node:assert/strict'
import { feedbackWidgetTag, iosAppVersion } from '../mcp-server/feedback-widget.mjs'

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1 UnlinkediOS/1.0.3'

test('iosAppVersion reads the shell version token and nothing else', () => {
  assert.equal(iosAppVersion(IOS), '1.0.3')
  assert.equal(iosAppVersion('Mozilla/5.0 (iPhone) Safari/604.1'), null)
  assert.equal(iosAppVersion('x UnlinkediOS/"><script>'), null)
  assert.equal(iosAppVersion(undefined), null)
  assert.equal(iosAppVersion(`${'a'.repeat(1100)} UnlinkediOS/1.0.0`), null)
})

test('web keeps the plain Unlinked label; the iOS app is labelled with its version', () => {
  const web = feedbackWidgetTag('n')
  assert.match(web, /data-trigger="none" data-app="Unlinked" data-app-version="\d+\.\d+\.\d+"/)
  const app = feedbackWidgetTag('n', { iosApp: '1.0.3' })
  assert.match(app, /data-tracker-slug="unlinked-feedback" data-trigger="none" data-app="Unlinked iOS" data-app-version="1\.0\.3 \(web \d+\.\d+\.\d+\)"/)
  assert.match(app, /^<script nonce="n" src="https:\/\/worldissuetracker\.com\/widget\/wit-feedback\.js"/)
})
