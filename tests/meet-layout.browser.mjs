import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { servePublicDiscovery } from '../mcp-server/public-discovery.mjs'

// Chrome's private CDP pipe avoids a listener and needs no browser npm dependency.
// Keep its sandbox enabled. CI supplies Chrome; locally use UNLINKED_TEST_CHROME.
async function browser(directory, executable = process.env.UNLINKED_TEST_CHROME || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium'].find(existsSync)) {
  assert.ok(executable, 'Chrome required; set UNLINKED_TEST_CHROME')
  const child = spawn(executable, ['--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${join(directory, 'profile')}`], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let id = 0, buffer = '', stderr = '', terminal
  const closed = new Promise(resolve => child.once('close', resolve))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
  child.stdio[4].on('data', chunk => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\0')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      const entry = pending.get(message.id)
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result) }
    }
  })
  const fail = error => { terminal ??= error; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(terminal) } pending.clear() }
  child.on('error', fail)
  child.stdio[3].on('error', fail)
  child.stdio[4].on('error', fail)
  child.on('exit', () => fail(Error(`Chrome exited: ${stderr}`)))
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (terminal) { reject(terminal); return }
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`Chrome timeout: ${method}: ${stderr}`)) }, 15000)
    pending.set(requestId, { resolve, reject, timer })
    child.stdio[3].write(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) fail(error) })
  })
  const settled = async (promise, ms) => {
    let timer
    try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
    finally { clearTimeout(timer) }
  }
  return { send, async close() {
    try {
      if (!terminal) await settled(send('Browser.close').catch(() => {}), 1000)
      if (!await settled(closed, 1000)) {
        child.kill('SIGTERM')
        if (!await settled(closed, 1000)) {
          child.kill('SIGKILL')
          assert.ok(await settled(closed, 2000), 'Chrome did not close after SIGKILL')
        }
      }
    } finally { fail(Error('Chrome closed')) }
  } }
}

test('Meet keeps its hidden photo input and document within 390/1280px', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'unlinked-meet-layout-'))
  let chrome
  try {
    const file = join(directory, 'meet.html')
    // Capture the actual public Meet document, including its production CSS.
    // This layout fixture strips scripts: no camera, server or data operations.
    let document
    await servePublicDiscovery({ method: 'GET', url: '/meet', headers: {} }, {
      setHeader() {}, writeHead(status) { assert.equal(status, 200) }, end(html) { document = html },
    }, '/meet', {}, { origin: 'https://meet-layout.invalid' })
    await writeFile(file, document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''))
    chrome = await browser(directory)
    for (const width of [390, 1280]) for (const scheme of ['light', 'dark']) await t.test(`${width}px ${scheme}`, async () => {
      const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' })
      try {
        const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true })
        const send = (method, params) => chrome.send(method, params, sessionId)
        await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
        await send('Page.navigate', { url: pathToFileURL(file).href })
        const { result, exceptionDetails } = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise(resolve => { const measure = () => { const input = document.querySelector('#scan-photo'), r = input.getBoundingClientRect(), s = getComputedStyle(input); resolve({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, width: r.width, height: r.height, position: s.position, clip: s.clip, label: document.querySelector('label[for="scan-photo"]').control === input, enabled: !input.disabled, dark: matchMedia('(prefers-color-scheme: dark)').matches }) }; document.readyState === 'complete' ? measure() : addEventListener('load', measure, { once: true }) })` })
        assert.equal(exceptionDetails, undefined)
        assert.equal(result.value.viewport, width)
        assert.equal(result.value.dark, scheme === 'dark')
        assert.ok(result.value.scrollWidth <= width, JSON.stringify(result.value))
        assert.equal(result.value.width, 1)
        assert.equal(result.value.height, 1)
        assert.equal(result.value.position, 'absolute')
        assert.equal(result.value.clip, 'rect(0px, 0px, 0px, 0px)')
        assert.equal(result.value.label, true)
        assert.equal(result.value.enabled, true)
      } finally { await chrome.send('Target.closeTarget', { targetId }) }
    })
  } finally { await chrome?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})


test('browser cleanup handles signal exit and failed spawn without hanging', { timeout: 10000 }, async t => {
  for (const mode of ['signal', 'missing']) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unlinked-meet-exit-'))
    let chrome
    try {
      const executable = join(directory, 'synthetic-browser')
      if (mode === 'signal') {
        await writeFile(executable, '#!/bin/sh\nkill -TERM "$$"\n')
        await chmod(executable, 0o700)
      }
      chrome = await browser(directory, executable)
      await assert.rejects(chrome.send('Browser.getVersion'), /Chrome exited|EPIPE|ECONNRESET|ENOENT/)
      await chrome.close()
      await assert.rejects(chrome.send('Browser.getVersion'))
    } finally { await chrome?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
})
