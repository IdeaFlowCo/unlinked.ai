import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserCardScanner } from '../src/utils/browser-card-scanner.js'

const card = 'https://chat.globalbr.ai/c/AbC123def456GHI789jkl012'

function fixture(t, getUserMedia) {
  const original = new Map(['navigator', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  let frame
  let stops = 0
  let removals = 0
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0, setAttribute() {}, async play() {}, pause() {}, remove() { removals++ } }
  const host = { appendChild(element) { assert.equal(element, video) } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: getUserMedia ?? (async () => ({ getTracks: () => [{ stop() { stops++ } }] })) } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: callback => { frame = callback; return 1 } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
  return { host, video, get frame() { return frame }, get stops() { return stops }, get removals() { return removals } }
}

test('camera starts on demand, rejects unrelated QR values, and opens one card', async t => {
  const setup = fixture(t)
  const opened = []
  let unsupported = 0
  const scanner = new BrowserCardScanner(setup.host, { onCard: token => opened.push(token), onUnsupportedCode: () => unsupported++ })
  assert.equal(setup.stops, 0)
  await scanner.start()
  scanner.acceptValue('https://evil.test/c/AbC123def456GHI789jkl012')
  scanner.acceptValue('https://evil.test/c/AbC123def456GHI789jkl012')
  assert.equal(unsupported, 1)
  scanner.acceptValue(card)
  scanner.acceptValue(card)
  setup.frame?.()
  assert.deepEqual(opened, ['AbC123def456GHI789jkl012'])
  assert.equal(setup.stops, 1)
  assert.equal(setup.removals, 1)
})

test('leaving before camera permission resolves stops the late stream', async t => {
  let resolvePermission
  let lateStopped = false
  const setup = fixture(t, () => new Promise(resolve => { resolvePermission = resolve }))
  const scanner = new BrowserCardScanner(setup.host, { onCard() {}, onUnsupportedCode() {} })
  const starting = scanner.start()
  scanner.stop()
  resolvePermission({ getTracks: () => [{ stop() { lateStopped = true } }] })
  await starting
  assert.equal(lateStopped, true)
  assert.equal(setup.frame, undefined)
})

test('camera decode attempts are spaced out and reuse the drawing surface', async t => {
  const setup = fixture(t)
  setup.video.readyState = 2
  setup.video.videoWidth = 64
  setup.video.videoHeight = 64
  let canvases = 0
  let reads = 0
  let draws = 0
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() { draws++ },
        getImageData(x, y, width, height) {
          reads++
          return { data: new Uint8ClampedArray(width * height * 4), width, height }
        },
      }
    },
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag) {
      if (tag === 'video') return setup.video
      assert.equal(tag, 'canvas')
      canvases++
      return canvas
    },
  } })
  const scanner = new BrowserCardScanner(setup.host, { onCard() {}, onUnsupportedCode() {} })
  await scanner.start()
  for (const timestamp of [0, 16, 100, 199, 200, 250, 400]) setup.frame(timestamp)
  assert.equal(canvases, 1)
  assert.equal(draws, 3)
  assert.equal(reads, 3)
  setup.video.videoWidth = 128
  setup.frame(600)
  assert.equal(canvas.width, 128)
  assert.equal(canvases, 1)
  assert.equal(reads, 4)
  scanner.stop()
  setup.frame(800)
  assert.equal(reads, 4)
})
