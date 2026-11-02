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
