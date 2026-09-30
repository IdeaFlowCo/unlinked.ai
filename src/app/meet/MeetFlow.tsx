'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import jsQR from 'jsqr'
import { parseOpenChatCard, openChatCardUrl } from '@/utils/openchat-card'
import { BrowserCardScanner } from '@/utils/browser-card-scanner'

type CameraState = 'idle' | 'starting' | 'scanning' | 'unavailable'
type OpenChatCard = NonNullable<ReturnType<typeof parseOpenChatCard>>

export default function MeetFlow() {
  const previewRef = useRef<HTMLDivElement>(null)
  const scannerRef = useRef<BrowserCardScanner | null>(null)
  const openedRef = useRef(false)
  const mountedRef = useRef(true)
  const [cameraState, setCameraState] = useState<CameraState>('idle')
  const [link, setLink] = useState('')
  const [message, setMessage] = useState('')

  const stopCamera = useCallback(() => {
    scannerRef.current?.stop()
    scannerRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; stopCamera() }
  }, [stopCamera])

  const openCard = useCallback((card: OpenChatCard) => {
    if (openedRef.current || !mountedRef.current) return
    openedRef.current = true
    stopCamera()
    window.location.assign(openChatCardUrl(card))
  }, [stopCamera])

  const acceptCode = useCallback((value: string) => {
    const card = parseOpenChatCard(value)
    if (card) openCard(card)
    else setMessage('This is not an OpenChat card. Ask for a current card QR code or paste its link.')
  }, [openCard])

  async function startCamera() {
    if (scannerRef.current || cameraState === 'starting' || cameraState === 'scanning' || openedRef.current) return
    setMessage('')
    setCameraState('starting')
    try {
      if (!previewRef.current) throw new Error('Camera unavailable')
      const scanner = new BrowserCardScanner(previewRef.current, {
        onCard: openCard,
        onUnsupportedCode: () => setMessage('This is not an OpenChat card. Ask for a current card QR code or paste its link.'),
      })
      scannerRef.current = scanner
      await scanner.start()
      if (!mountedRef.current || openedRef.current || scannerRef.current !== scanner) { scanner.stop(); return }
      setCameraState('scanning')
    } catch {
      stopCamera()
      if (mountedRef.current) {
        setCameraState('unavailable')
        setMessage('Camera access was denied or unavailable. You can use your phone camera below or paste a card URL.')
      }
    }
  }

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    acceptCode(link)
  }

  async function captureCard(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || openedRef.current) return
    setMessage('Reading the QR code…')
    const objectUrl = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.round(image.naturalWidth * scale)
      canvas.height = Math.round(image.naturalHeight * scale)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Image decoding unavailable')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
      if (code) acceptCode(code.data)
      else setMessage('No QR code was found in that photo. Try again or paste the card URL.')
    } catch {
      setMessage('Could not read that photo. Try again or paste the card URL.')
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  return <div className="meet-options">
    <section className="meet-card scan-card" aria-labelledby="scan-title"><div className="option-number">01 / SCAN</div><h2 id="scan-title">Scan a card</h2><p>Point your camera at someone’s OpenChat QR card.</p>
      <div ref={previewRef} className={`camera-preview ${cameraState === 'scanning' ? 'is-scanning' : ''}`}><div className="camera-target" aria-hidden="true"><span /><span /><span /><span /></div>{cameraState !== 'scanning' && <span className="camera-placeholder">{cameraState === 'starting' ? 'Starting camera…' : 'Camera is off'}</span>}</div>
      {cameraState === 'scanning' ? <button type="button" className="public-button public-button-quiet" onClick={() => { stopCamera(); setCameraState('idle') }}>Stop camera</button> : <button type="button" className="public-button public-button-primary" onClick={() => { void startCamera() }}>{cameraState === 'starting' ? 'Starting…' : 'Start camera'}</button>}
    </section>
    <section className="meet-card alternate-card" aria-labelledby="paste-title"><div className="option-number">02 / PASTE</div><h2 id="paste-title">Paste a card URL</h2><p>Have a link instead? Use the full OpenChat card URL from chat.globalbr.ai or chat.ideaflow.app.</p>
      <form onSubmit={submitLink}><label htmlFor="card-url">OpenChat card URL</label><input id="card-url" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://chat.globalbr.ai/c/…" value={link} onChange={event => setLink(event.target.value)} required /><button className="public-button public-button-primary" type="submit">Open card <span aria-hidden="true">↗</span></button></form>
      <div className="alternate-divider"><span>or use your phone</span></div>
      <label className="public-button public-button-outline native-camera" htmlFor="camera-photo">Use phone camera <span aria-hidden="true">↗</span></label><input id="camera-photo" className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={event => { void captureCard(event) }} /><p className="camera-help">Your phone’s camera can take a photo of the QR code. You can also scan it in the Camera app to open OpenChat directly.</p>
    </section>
    {message && <div className="meet-message" role="alert">{message}</div>}
  </div>
}
