import jsQR from 'jsqr'
import { parseOpenChatCard } from './openchat-card.js'

/** One camera visit. The owner must call stop on exit. `parse` validates a raw
 * QR value into the object handed to onCard; it defaults to OpenChat cards. */
export class BrowserCardScanner {
  constructor(host, { onCard, onUnsupportedCode, parse = parseOpenChatCard }) {
    this.host = host
    this.onCard = onCard
    this.onUnsupportedCode = onUnsupportedCode
    this.parse = parse
    this.stream = null
    this.video = null
    this.frame = null
    this.canvas = null
    this.context = null
    this.lastScanAt = -Infinity
    this.stopped = false
    this.navigated = false
    this.lastUnsupported = null
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } })
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return }
    this.stream = stream
    const video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.setAttribute('aria-label', 'Camera preview for scanning a card')
    video.srcObject = stream
    this.video = video
    this.host.appendChild(video)
    try {
      await video.play()
      if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame)
    } catch (error) { this.stop(); throw error }
  }

  scanFrame = (timestamp) => {
    if (this.stopped || !this.video) return
    const video = this.video
    if (timestamp - this.lastScanAt >= 200 && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas')
        this.context = this.canvas.getContext('2d', { willReadFrequently: true })
      }
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
      const width = Math.round(video.videoWidth * scale)
      const height = Math.round(video.videoHeight * scale)
      if (this.canvas.width !== width) this.canvas.width = width
      if (this.canvas.height !== height) this.canvas.height = height
      if (this.context) {
        this.lastScanAt = timestamp
        this.context.drawImage(video, 0, 0, width, height)
        const pixels = this.context.getImageData(0, 0, width, height)
        const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
        if (code) this.acceptValue(code.data)
      }
    }
    if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame)
  }

  acceptValue(value) {
    if (this.stopped || this.navigated) return
    const card = this.parse(value)
    if (card) {
      this.navigated = true
      this.stop()
      this.onCard(card)
    } else if (this.lastUnsupported !== value) {
      this.lastUnsupported = value
      this.onUnsupportedCode()
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.stream?.getTracks().forEach(track => track.stop())
    if (this.video) {
      this.video.pause()
      this.video.srcObject = null
      this.video.remove()
    }
    this.stream = null
    this.video = null
    this.frame = null
    this.canvas = null
    this.context = null
  }
}

/** Reads a QR code from an image file (a photo or a screenshot chosen with
 * "Scan from photo"). Returns the raw value or null. The picture is drawn at a
 * few sizes because phone screenshots are large and photos are noisy; it never
 * leaves the browser. */
export async function decodeImageFile(file, { sizes = [1600, 900, 2400] } = {}) {
  if (!file || typeof file.size !== 'number' || file.size === 0 || file.size > 30 * 1024 * 1024) return null
  const image = await loadImage(file)
  try {
    const width = image.width, height = image.height
    if (!width || !height) return null
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    for (const side of sizes) {
      const scale = Math.min(1, side / Math.max(width, height))
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
      context.drawImage(image.element ?? image, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
      if (code?.data) return code.data
      if (scale === 1) break
    }
    return null
  } finally { image.close?.() }
}

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(file) } catch { /* fall back to an image element */ } }
  const url = URL.createObjectURL(file)
  try {
    const element = new Image()
    element.decoding = 'async'
    await new Promise((resolve, reject) => { element.onload = resolve; element.onerror = () => reject(new Error('image_unreadable')); element.src = url })
    return { width: element.naturalWidth, height: element.naturalHeight, element, close() {} }
  } finally { URL.revokeObjectURL(url) }
}
