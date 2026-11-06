#!/usr/bin/env node
// Crawl a running Unlinked site and report every internal link that does not
// end in a 2xx page. Read-only: it only issues GET requests, never follows
// sign-out or sign-in hops, and is throttled so a production run stays well
// inside the public 120-requests-a-minute budget real visitors share.
//
//   node scripts/check-internal-links.mjs https://www.unlinked.ai \
//     [--seed /people/aakarshgpt ...] [--pages 80] [--per-kind 25] \
//     [--delay 1000] [--cookie-file path] [--json report.json]
//
// --cookie-file holds one Cookie header value (e.g. a test persona's session),
// so signed-in pages such as /network and /notifications are crawled too.
// Exit code 1 when any broken link is found.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback }
const options = name => args.flatMap((value, index) => value === `--${name}` ? [args[index + 1]] : [])
const base = new URL(args.find(value => /^https?:\/\//.test(value)) ?? 'http://127.0.0.1:8787')
const maxPages = Number(option('pages', 80)), perKind = Number(option('per-kind', 25)), delay = Number(option('delay', 1000))
const cookie = option('cookie-file') ? readFileSync(option('cookie-file'), 'utf8').trim() : ''
const seeds = [...(cookie ? ['/', '/network', '/notifications', '/invitations', '/profile', '/card'] : ['/', '/people']), ...options('seed')]

// Links that leave the site, act, or hand off to the identity provider.
const SKIP = [/^\/logout\b/, /^\/login\b/, /^\/auth\//, /^\/oauth\//, /^\/signout\b/, /^\/mcp\b/, /^\/messages\/api\//, /^\/export\b/, /\.ics$/, /\/photo$/]
// Which crawled pages expand into more pages, grouped so the sample is broad
// instead of 80 profiles from one connection list.
const kindOf = path => path.startsWith('/companies/') ? 'company' : /^\/people\/[^/?]+\/connections/.test(path) ? 'connections' : /^\/people\/[^/?]+/.test(path) ? 'profile' : /^\/network\/contacts\//.test(path) ? 'contact' : path.split(/[/?]/)[1] || 'home'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let last = 0, requests = 0
async function get(path) {
  for (let attempt = 0; ; attempt++) {
    const wait = last + delay - Date.now(); if (wait > 0) await sleep(wait)
    last = Date.now(); requests++; if (args.includes('--verbose')) process.stderr.write(`\nGET ${path}`)
    let response
    try { response = await fetch(new URL(path, base), { redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'unlinked-link-check/1', ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(30000) }) } catch (error) { if (attempt < 2) { await sleep(3000); continue } return { status: 0, error: error.message } }
    // 429 is the budget, 502/503 a warming graph: wait and retry, then report.
    if ([429, 502, 503].includes(response.status) && attempt < 4) { await response.arrayBuffer(); await sleep(response.status === 429 ? 15000 : 5000); continue }
    const location = response.headers.get('location')
    const body = response.status === 200 && (response.headers.get('content-type') ?? '').includes('text/html') ? await response.text() : (await response.arrayBuffer(), '')
    // A members-only page answers signed-out visitors with a sign-in page (401 HTML): a wall, not a dead link.
    const wall = response.status === 401 && (response.headers.get('content-type') ?? '').includes('text/html')
    return { status: response.status, location, body, ...(wall ? { wall: true } : {}) }
  }
}

// Follow same-site redirects (handles, merged ids) to the final status.
async function resolve(path) {
  const hops = []
  for (let hop = 0; hop < 6; hop++) {
    const result = await get(path)
    if (result.status >= 300 && result.status < 400 && result.location) {
      const next = new URL(result.location, new URL(path, base))
      hops.push(result.status)
      if (next.origin !== base.origin) return { ...result, status: 200, external: next.href, hops }
      path = next.pathname + next.search
      if (SKIP.some(rule => rule.test(path))) return { ...result, status: 200, skipped: path, hops }
      continue
    }
    return { ...result, final: path, hops }
  }
  return { status: 'redirect-loop', final: path, hops }
}

const entity = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
function links(html, from) {
  const found = []
  for (const match of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = entity(match[1])
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data|sms|intent|instagram|barcelona|x-safari-https):/i.test(href)) continue
    let url; try { url = new URL(href, new URL(from, base)) } catch { found.push({ path: href, text: '', malformed: true }); continue }
    if (url.origin !== base.origin) continue
    const path = url.pathname + url.search
    if (SKIP.some(rule => rule.test(path))) continue
    found.push({ path, text: entity(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  return found
}

const checked = new Map(), sources = new Map(), queue = [...seeds], expanded = new Set(), perKindCount = new Map()
while (queue.length && expanded.size < maxPages) {
  const page = queue.shift()
  if (expanded.has(page)) continue
  const kind = kindOf(page)
  if ((perKindCount.get(kind) ?? 0) >= perKind) continue
  const result = checked.get(page) ?? await resolve(page)
  checked.set(page, { ...result, body: '' })
  if (result.status !== 200 || !result.body) continue
  expanded.add(page); perKindCount.set(kind, (perKindCount.get(kind) ?? 0) + 1)
  for (const link of links(result.body, result.final ?? page)) {
    if (!sources.has(link.path)) sources.set(link.path, [])
    if (sources.get(link.path).length < 3) sources.get(link.path).push({ from: page, text: link.text, malformed: link.malformed })
    if (!checked.has(link.path)) {
      const target = link.malformed ? { status: 'malformed' } : await resolve(link.path)
      checked.set(link.path, target)
      if (target.status === 200 && target.body) queue.push(link.path)
    }
  }
  process.stderr.write(`\r${expanded.size} pages, ${checked.size} links, ${requests} requests`)
}
process.stderr.write('\n')

const walls = [...checked].filter(([, result]) => result.wall).map(([path]) => path)
const broken = [...checked].filter(([, result]) => result.status !== 200 && !result.wall).map(([path, result]) => ({ path, status: result.status, hops: result.hops, linkedFrom: sources.get(path) ?? [{ from: '(seed)' }] }))
const summary = { base: base.origin, signedIn: Boolean(cookie), pages: expanded.size, links: checked.size, requests, byKind: Object.fromEntries(perKindCount), signInWalls: walls, broken }
if (option('json')) writeFileSync(option('json'), JSON.stringify(summary, null, 2))
console.log(`${summary.pages} pages crawled, ${summary.links} distinct internal links checked, ${broken.length} broken, ${walls.length} sign-in walls (${walls.slice(0, 8).join(' ')})`)
for (const value of broken) console.log(`${value.status}  ${value.path}\n      from ${value.linkedFrom.map(source => `${source.from}${source.text ? ` ("${source.text}")` : ''}`).join(', ')}`)
process.exitCode = broken.length ? 1 : 0
