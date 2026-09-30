import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { writeFile, readFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'

const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alice = '11111111-1111-4111-8111-111111111111'
const bob = '22222222-2222-4222-8222-222222222222'

async function capture(evidence, name, width, height) {
  // Export the actual hydrated DOM with its loaded CSS. This stays reviewable
  // even when the browser bridge runs elsewhere and cannot save local files.
  const exported = await run('chrome-devtools-axi', ['eval', `() => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,link,style,nextjs-portal').forEach(node => node.remove());
    const style = document.createElement('style');
    style.textContent = Array.from(document.styleSheets).flatMap(sheet => { try { return Array.from(sheet.cssRules).map(rule => rule.cssText) } catch { return [] } }).join('\\n');
    clone.querySelector('head').appendChild(style);
    return btoa(unescape(encodeURIComponent('<!doctype html>' + clone.outerHTML)));
  }`, '--full'], { maxBuffer: 8 * 1024 * 1024 })
  const resultLine = exported.stdout.split('\n').find(line => line.startsWith('result: '))
  assert.ok(resultLine, exported.stdout)
  const html = Buffer.from(JSON.parse(JSON.parse(resultLine.slice(8))), 'base64').toString('utf8')
  assert.ok(html.startsWith('<!doctype html>'))
  await writeFile(`${evidence}/${name}.html`, html)
  const profile = await mkdtemp(`${process.cwd()}/.unipile-browser-`)
  let browser
  try {
    await rm(`${evidence}/${name}.png`, { force: true })
    browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `file://${evidence}/${name}.html`], { stdio: 'ignore' })
    let debugPort
    for (let attempt = 0; attempt < 200; attempt++) {
      try { debugPort = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0]; break } catch {}
      await sleep(100)
    }
    assert.ok(debugPort, 'Chrome debugging endpoint did not become available')
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    const target = targets.find(item => item.type === 'page')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await once(socket, 'open')
    let sequence = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
    })
    async function command(method, params = {}) {
      const id = ++sequence
      const response = new Promise(resolve => pending.set(id, resolve))
      socket.send(JSON.stringify({ id, method, params }))
      const message = await response
      assert.equal(message.error, undefined, JSON.stringify(message.error))
      return message.result
    }
    // CDP viewport emulation avoids Chrome's minimum desktop window width.
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await command('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true })
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(`${evidence}/${name}.png`, Buffer.from(screenshot.data, 'base64'))
    socket.close()
    assert.ok((await stat(`${evidence}/${name}.png`)).size > 1000)
  } finally {
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit')
      browser.kill('SIGKILL')
      await exited
    }
    await rm(profile, { recursive: true, force: true })
  }
}

function session(userId) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`
  const value = `base64-${encode({ access_token: token, refresh_token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: { id: userId } })}`
  return `sb-127-auth-token=${value}`
}

test('real Next HTTP lab gates and explicit fixture preview actions', { timeout: 180_000 }, async () => {
  // Local auth fixture exercises the real cookie/auth adapter without contacting
  // the paused Supabase backend. Provider operations remain synthetic.
  const auth = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url.startsWith('/auth/v1/user')) {
      const token = request.headers.authorization?.split(' ')[1]
      let sub
      try { sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub } catch {}
      if (!sub) { response.writeHead(401); response.end('{}'); return }
      response.end(JSON.stringify({ id: sub, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {} }))
    } else if (request.url.startsWith('/rest/v1/profiles')) {
      response.end(JSON.stringify({ id: alice, full_name: 'Fixture tester' }))
    } else { response.writeHead(404); response.end('{}') }
  })
  auth.listen(0, '127.0.0.1')
  await once(auth, 'listening')
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  let child
  let output = ''
  const transcript = []
  async function stop() {
    if (!child || child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  async function start(enabled) {
    const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon-key', UNLINKED_UNIPILE_TEST_ENABLED: String(enabled), UNLINKED_UNIPILE_TEST_MODE: 'fixture', UNLINKED_UNIPILE_TEST_USER_IDS: alice }
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`Next exited: ${output.slice(-3000)}`)
      try { await fetch(`${origin}/api/unipile-lab`); return } catch {}
      await sleep(200)
    }
    throw new Error(`Next did not start: ${output.slice(-3000)}`)
  }
  async function request(path, expected, { user, action, url, requestOrigin = origin, body } = {}) {
    const response = await fetch(origin + path, { headers: { ...(user ? { cookie: session(user) } : {}), ...(action || body ? { origin: requestOrigin, 'Content-Type': 'application/json' } : {}) }, ...(action || body ? { method: 'POST', body: body ?? JSON.stringify({ action, url }) } : {}) })
    assert.equal(response.status, expected, `${path}: ${await response.clone().text()}`)
    const text = await response.text()
    const value = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text
    transcript.push({ phase: enabledPhase, path, actor: user === alice ? 'allowlisted tester' : user === bob ? 'other tester' : 'signed out', action, status: response.status, cacheControl: response.headers.get('cache-control'), ...(typeof value === 'object' ? { result: value.url ? { hostedLink: 'synthetic', mode: value.mode } : value } : {}) })
    return value
  }
  let enabledPhase = false
  try {
    await start(false)
    await request('/unipile-lab', 404, { user: alice })
    await request('/api/unipile-lab', 404, { user: alice })
    await request('/api/unipile-lab/callback', 404, { body: '{}' })
    await stop()
    enabledPhase = true
    await start(true)
    await request('/unipile-lab', 404)
    await request('/api/unipile-lab', 404)
    await request('/unipile-lab', 404, { user: bob })
    await request('/api/unipile-lab', 404, { user: bob, action: 'preview-target', url: 'https://linkedin.com/in/fixture-target' })
    const page = await request('/unipile-lab', 200, { user: alice })
    assert.ok(page.includes('LinkedIn, in view.'))
    assert.equal((await request('/api/unipile-lab', 200, { user: alice })).connected, false)
    await request('/api/unipile-lab', 403, { user: alice, action: 'preview-target', requestOrigin: 'https://evil.example' })
    await request('/api/unipile-lab', 403, { user: alice, action: 'own-connections' })
    await request('/api/unipile-lab', 400, { user: alice, action: 'preview-target', url: 'https://evil.example/in/fixture-target' })
    const preview = await request('/api/unipile-lab', 200, { user: alice, action: 'preview-target', url: 'https://linkedin.com/in/fixture-target' })
    assert.equal(preview.preview.mode, 'demo')
    assert.equal(preview.preview.target.id, 'fixture-target')
    assert.equal(preview.preview.people, undefined)
    await request('/api/unipile-lab', 409, { user: alice, action: 'target-connections', url: 'https://linkedin.com/in/different-target' })
    const connections = await request('/api/unipile-lab', 200, { user: alice, action: 'target-connections', url: 'https://linkedin.com/in/fixture-target' })
    assert.equal(connections.preview.outcome, 'empty')
    assert.deepEqual(connections.preview.people, [])
    assert.equal(connections.preview.target.id, 'fixture-target')
    await request('/api/unipile-lab', 200, { user: alice, action: 'reset' })
    assert.equal((await request('/api/unipile-lab', 200, { user: alice })).preview, undefined)
    await request('/api/unipile-lab', 200, { user: alice, action: 'connect' })
    await request('/unipile-lab?return=success', 200, { user: alice })
    const returned = await request('/api/unipile-lab', 200, { user: alice })
    assert.equal(returned.connected, false)
    assert.equal(returned.connectionOutcome.status, 'pending')
    await request('/api/unipile-lab/callback', 403, { body: JSON.stringify({ name: 'forged', status: 'CREATION_SUCCESS', account_id: 'forged-account' }) })
    if (process.env.UNIPILE_EVIDENCE_DIR) {
      const evidence = process.env.UNIPILE_EVIDENCE_DIR
      await mkdir(evidence, { recursive: true })
      await writeFile(`${evidence}/http-story.json`, JSON.stringify({ authentication: 'Local synthetic Supabase auth; real Next.js page, routes, and fixture provider', requests: transcript }, null, 2))
      await run('chrome-devtools-axi', ['newpage', origin + '/unipile-lab'])
      const pages = await run('chrome-devtools-axi', ['pages'])
      const pageId = [...pages.stdout.matchAll(/^\s+(\d+),/gm)].at(-1)?.[1]
      assert.ok(pageId, pages.stdout)
      await run('chrome-devtools-axi', ['selectpage', pageId])
      await run('chrome-devtools-axi', ['eval', `() => { document.cookie = ${JSON.stringify(session(alice) + '; path=/')}; return document.cookie }`])
      await run('chrome-devtools-axi', ['open', origin + '/unipile-lab'])
      await run('chrome-devtools-axi', ['wait', 'LinkedIn, in view.'])
      await sleep(1000)
      await run('chrome-devtools-axi', ['resize', '1440', '1200'])
      const ready = await run('chrome-devtools-axi', ['eval', `document.body.innerText`])
      assert.ok(ready.stdout.includes('Synthetic fixture'), ready.stdout)
      // React's controlled input must be edited with the native value setter.
      await run('chrome-devtools-axi', ['eval', `() => { const input = document.querySelector('#profile-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://linkedin.com/in/fixture-target'); input.dispatchEvent(new Event('input', {bubbles:true})); }`])
      await run('chrome-devtools-axi', ['eval', `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Preview through demo')).click()`])
      await run('chrome-devtools-axi', ['wait', 'Viewed through the demo account'])
      const previewText = await run('chrome-devtools-axi', ['eval', 'document.body.innerText'])
      assert.ok(previewText.stdout.toLowerCase().includes('viewed through the demo account'), previewText.stdout)
      assert.ok(previewText.stdout.includes('Fixture fixture-target'), previewText.stdout)
      await capture(evidence, 'panel-demo-preview', 1440, 1400)
      await run('chrome-devtools-axi', ['eval', `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Check visible connections').click()`])
      await run('chrome-devtools-axi', ['wait', 'No visible people appeared on this page.'])
      const emptyText = await run('chrome-devtools-axi', ['eval', 'document.body.innerText'])
      assert.ok(emptyText.stdout.includes('No visible people appeared on this page.'), emptyText.stdout)
      await capture(evidence, 'panel-demo-empty', 1440, 1500)
      await run('chrome-devtools-axi', ['resize', '390', '844'])
      await capture(evidence, 'panel-mobile', 390, 2100)
      await run('chrome-devtools-axi', ['closepage', pageId])
    }
  } finally {
    await stop()
    await new Promise(resolve => auth.close(resolve))
  }
})
