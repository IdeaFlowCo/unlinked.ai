import jsQR from 'jsqr'
import { parseOpenChatCard } from './openchat-card.js'

/** One camera visit. The owner must call stop on exit. */
export class BrowserCardScanner {
  constructor(host, { onCard, onUnsupportedCode }) {
    this.host = host
    this.onCard = onCard
    this.onUnsupportedCode = onUnsupportedCode
    this.stream = null
    this.video = null
    this.frame = null
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
    video.setAttribute('aria-label', 'Camera preview for scanning an OpenChat card')
    video.srcObject = stream
    this.video = video
    this.host.appendChild(video)
    try {
      await video.play()
      if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame)
    } catch (error) { this.stop(); throw error }
  }

  scanFrame = () => {
    if (this.stopped || !this.video) return
    const video = this.video
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
        if (code) this.acceptValue(code.data)
      }
    }
    if (!this.stopped) this.frame = requestAnimationFrame(this.scanFrame)
  }

  acceptValue(value) {
    if (this.stopped || this.navigated) return
    const token = parseOpenChatCard(value)
    if (token) {
      this.navigated = true
      this.stop()
      this.onCard(token)
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
  }
}
