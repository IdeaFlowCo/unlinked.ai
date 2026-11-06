import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderCard, renderScan, CARD_SHARE_SCRIPT } from '../mcp-server/private-onboarding-views.mjs'

const profile = { name: 'Ada Example', headline: 'Engineer' }
const cardUrl = 'https://www.unlinked.ai/people/ada-example'
const contact = { settings: {}, card: { name: 'Ada Example', email: 'ada@example.test' }, shareUrl: 'https://www.unlinked.ai/c/a1B2c3D4e5F6g7H8i9J0k1L2', qr: '<svg></svg>' }

// The link under the QR code is the same URL the code encodes, readable, with
// Copy link always and Share… only where the browser has a share sheet.
test('public card: the permalink is shown, copyable and shareable', () => {
  const { content } = renderCard({ csrf: 'test', profile, cardUrl, qr: '<svg></svg>', contact, share: 'public' })
  assert.match(content, /<div class="share-link" data-share-url="https:\/\/www\.unlinked\.ai\/people\/ada-example" data-share-title="Ada Example on Unlinked">/)
  assert.match(content, /<label for="share-public">Link to my public profile<\/label>/)
  assert.match(content, /<input class="share-url" id="share-public" type="text" readonly value="https:\/\/www\.unlinked\.ai\/people\/ada-example"/)
  assert.match(content, /<button type="button" class="sm" data-share-copy aria-describedby="share-public-help">Copy link<\/button>/)
  assert.match(content, /<button type="button" class="quiet sm" data-share-send hidden>Share…<\/button>/)
  assert.doesNotMatch(content, /class="small qr-url"/)
})

test('contact card: the link block keeps the cc-link-out field and adds Copy and Share', () => {
  const { content } = renderCard({ csrf: 'test', profile, cardUrl, qr: '<svg></svg>', contact })
  assert.match(content, /<label for="cc-link-out">Link to this card<\/label>/)
  assert.match(content, /id="cc-link-out" type="text" readonly value="https:\/\/www\.unlinked\.ai\/c\/a1B2c3D4e5F6g7H8i9J0k1L2"/)
  assert.match(content, /data-share-url="https:\/\/www\.unlinked\.ai\/c\/a1B2c3D4e5F6g7H8i9J0k1L2"/)
  assert.equal(content.match(/Copy link/g).length, 1)
  // No link when the card is not shared.
  const off = renderCard({ csrf: 'test', profile, cardUrl, qr: '<svg></svg>', contact: { settings: { shareCard: false }, card: null, shareUrl: null } })
  assert.doesNotMatch(off.content, /class="share-link"/)
})

test('scan sheet My card tab: the contact link is on the sheet too', () => {
  const { content } = renderScan({ csrf: 'test', profile, cardUrl, qr: '<svg></svg>', contact, tab: 'card' })
  assert.match(content, /id="panel-card"[^>]*>(?:(?!<\/div><\/section>).)*data-share-url="https:\/\/www\.unlinked\.ai\/c\/a1B2c3D4e5F6g7H8i9J0k1L2"/s)
  assert.match(content, /Copy link/)
  // Without a contact card the public permalink stands in.
  const pub = renderScan({ csrf: 'test', profile, cardUrl, qr: '<svg></svg>', tab: 'card' })
  assert.match(pub.content, /data-share-url="https:\/\/www\.unlinked\.ai\/people\/ada-example"/)
})

test('share script: clipboard copy with a select fallback, share sheet only when available, installed on every page', async () => {
  assert.match(CARD_SHARE_SCRIPT, /navigator\.clipboard\.writeText\(url\)/)
  assert.match(CARD_SHARE_SCRIPT, /Selected\. Copy it from the field above\./)
  assert.match(CARD_SHARE_SCRIPT, /typeof navigator\.share==='function'/)
  assert.match(CARD_SHARE_SCRIPT, /navigator\.share\(\{title,url\}\)/)
  assert.match(CARD_SHARE_SCRIPT, /AbortError/)
  const browser = await readFile(new URL('../mcp-server/private-browser.mjs', import.meta.url), 'utf8')
  assert.match(browser, /\$\{HOVER_CARD_SCRIPT\}\$\{CARD_SHARE_SCRIPT\}/)
})
