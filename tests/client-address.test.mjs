import test from 'node:test'
import assert from 'node:assert/strict'
import { visitorKey } from '../mcp-server/client-address.mjs'

const request = (headers, remoteAddress = '172.18.0.3') => ({ headers, socket: { remoteAddress } })

test('Cloudflare edges name the visitor; direct peers name themselves', () => {
  // Through Cloudflare: the edge is the peer and CF-Connecting-IP is the visitor.
  assert.equal(visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7')
  assert.equal(visitorKey(request({ 'x-forwarded-for': '2606:4700:10::1', 'cf-connecting-ip': '203.0.113.4' })), '203.0.113.4')
  // A non-Cloudflare peer cannot pick its own budget with the header.
  assert.equal(visitorKey(request({ 'x-forwarded-for': '198.51.100.20', 'cf-connecting-ip': '203.0.113.99' })), '198.51.100.20')
  // An edge without a usable visitor header has no key (the shared fuse applies).
  assert.equal(visitorKey(request({ 'x-forwarded-for': '172.70.1.2' })), null)
  assert.equal(visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' })), null)
  assert.equal(visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': 'not-an-ip' })), null)
  // Without the ingress header, the socket peer is used (IPv4-mapped normalised).
  assert.equal(visitorKey(request({}, '::ffff:198.51.100.30')), '198.51.100.30')
  assert.equal(visitorKey({ headers: {}, socket: {} }), null)
})

test('IPv6 visitors share one budget per /64', () => {
  const a = visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': '2001:db8:aa:bb:1::1' }))
  const b = visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': '2001:db8:aa:bb:ffff:2:3:4' }))
  const c = visitorKey(request({ 'x-forwarded-for': '172.70.1.2', 'cf-connecting-ip': '2001:db8:aa:bc::1' }))
  assert.equal(a, '2001:0db8:00aa:00bb::/64'); assert.equal(a, b); assert.notEqual(a, c)
})

test('declared crawlers and non-browser clients are automation; browsers are not', async () => {
  const { declaredAutomation } = await import('../mcp-server/client-address.mjs')
  const ua = agent => declaredAutomation({ headers: agent === undefined ? {} : { 'user-agent': agent } })
  for (const agent of [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0',
    'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Reflectionbot/1.0; +https://reflection.ai/bot) Chrome/151.0.0.0 Safari/537.36',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.7727.15 Safari/537.36',
    'curl/8.7.1', 'python-requests/2.32', 'node', '', undefined,
  ]) assert.equal(ua(agent), true, String(agent))
  for (const agent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp',
  ]) assert.equal(ua(agent), false, agent)
})
