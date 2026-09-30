'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ConnectionOutcome, Preview } from '@/utils/unipile-lab'
import styles from './panel.module.css'

type Action = 'connect' | 'reconnect' | 'own-connections' | 'preview-target' | 'target-connections' | 'reset'

export default function LabPanel() {
  const [connected, setConnected] = useState(false)
  const [hasSource, setHasSource] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<Action | null>(null)
  const [message, setMessage] = useState('')
  const [returned, setReturned] = useState(false)
  const [connectionOutcome, setConnectionOutcome] = useState<ConnectionOutcome | null>(null)
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture')

  const load = useCallback(async () => {
    const response = await fetch('/api/unipile-lab', { cache: 'no-store' })
    if (!response.ok) { setMessage('Private lab is unavailable.'); return }
    const data = await response.json()
    setConnectionOutcome(data.connectionOutcome ?? null)
    setConnected(!!data.connected)
    setHasSource(!!data.hasSource)
    setPreview(data.preview ?? null)
    if (data.preview?.mode === 'demo' && data.preview.target?.publicUrl) setUrl(data.preview.target.publicUrl)
    setMode(data.mode === 'live' ? 'live' : 'fixture')
  }, [])

  useEffect(() => {
    setReturned(new URLSearchParams(window.location.search).has('return'))
    void load()
  }, [load])

  useEffect(() => {
    if (!preview) return
    const remaining = Math.max(0, new Date(preview.viewedAt).getTime() + 10 * 60_000 - Date.now())
    const timer = window.setTimeout(() => setPreview(null), remaining)
    return () => window.clearTimeout(timer)
  }, [preview])

  async function act(action: Action) {
    if (busy) return
    setBusy(action)
    setMessage('')
    if (action === 'preview-target') setPreview(null)
    try {
      const response = await fetch('/api/unipile-lab', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(action === 'preview-target' ? { url } : action === 'target-connections' ? { url: preview?.target?.publicUrl } : {}) }),
      })
      const data = await response.json()
      if (!response.ok) { setMessage(`${data.outcome ? `Outcome: ${data.outcome}. ` : ''}${data.error ?? 'Preview unavailable.'}`); return }
      if (data.url) {
        if (data.mode === 'fixture') { setMessage('Fixture mode: Hosted Auth is synthetic and cannot complete a real connection.'); return }
        window.location.assign(data.url); return
      }
      setPreview(data.preview ?? null)
      await load()
    } catch { setMessage('Preview unavailable. Check the connection and try later.') }
    finally { setBusy(null) }
  }

  return <main className={styles.lab}>
    <header className={styles.header}>
      <div className={styles.kicker}>UNLINKED / PRIVATE TEST LAB</div>
      <h1>LinkedIn, in view.</h1>
      <p>Two small, separate experiments. Nothing here claims a profile, publishes a contact, or syncs a network into Unlinked.</p>
      <div className={styles.status}><span className={styles.dot} />{mode === 'fixture' ? 'Synthetic fixture' : 'Live test'} · preview only · one page · up to ten people</div>
    </header>

    {message && <div className={styles.notice} role="alert">{message}</div>}
    {connectionOutcome && <div className={styles.notice} role="status">
      Connection outcome: {connectionOutcome.status}.
      {connectionOutcome.status === 'pending' ? ' Awaiting server verification; refresh after the provider callback arrives.' :
        connectionOutcome.status === 'verified' ? ' LinkedIn source verified.' : ' Linkage was not verified. Start Hosted Auth again to retry.'}
    </div>}
    {returned && !connected && !connectionOutcome &&
      <div className={styles.notice}>Hosted Auth returned. No active verification is available; start Hosted Auth again.</div>}

    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="own-heading">
        <div className={styles.cardTop}><span>01 / YOUR SOURCE</span><span>Authenticated Unlinked tester</span></div>
        <h2 id="own-heading">Connect my LinkedIn</h2>
        <p>Attach your own account as a private test source. Provider login and any challenge happen in Hosted Auth.</p>
        <div className={styles.identity}>Source owner <strong>{connected ? 'Linked · verified by provider' : hasSource ? 'Unverified · reconnect required' : 'Not linked'}</strong></div>
        <div className={styles.actions}>
          <button disabled={!!busy || hasSource} onClick={() => void act('connect')}>Start Hosted Auth ↗</button>
          {connected && <button className={styles.secondary} disabled={!!busy} onClick={() => void act('own-connections')}>Show up to 10 of my connections</button>}
          {hasSource && <button className={styles.tertiary} disabled={!!busy} onClick={() => void act('reconnect')}>Reconnect my source</button>}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="demo-heading">
        <div className={styles.cardTop}><span>02 / LOOKUP</span><span>Designated demo viewer</span></div>
        <h2 id="demo-heading">Preview a profile</h2>
        <p>Paste a LinkedIn profile URL. The URL is lookup input and says nothing about who owns that profile.</p>
        <label htmlFor="profile-url">LinkedIn profile URL</label>
        <input id="profile-url" disabled={!!busy} type="url" inputMode="url" placeholder="https://www.linkedin.com/in/person-name" value={url} onChange={event => { setUrl(event.target.value); if (preview?.mode === 'demo') setPreview(null) }} />
        <div className={styles.actions}>
          <button disabled={!!busy || !url.trim()} onClick={() => void act('preview-target')}>Preview through demo account →</button>
          {preview?.mode === 'demo' && <button className={styles.secondary} disabled={!!busy} onClick={() => void act('target-connections')}>Check visible connections</button>}
        </div>
      </section>
    </div>

    {preview && <section className={styles.result} aria-live="polite">
      <div className={styles.resultHead}><span>{preview.mode === 'demo' ? 'Viewed through the demo account' : 'Your linked source'}</span><span>{new Date(preview.viewedAt).toLocaleString()}</span></div>
      <h2>{preview.target?.name ?? (preview.mode === 'own' ? 'Your connections' : 'Visible connections')}</h2>
      {preview.target?.headline && <p>{preview.target.headline}</p>}
      {preview.target?.publicUrl && <p className={styles.url}>{preview.target.publicUrl}</p>}
      <div className={styles.outcome}>Outcome: {preview.outcome}{preview.mode === 'demo' ? ' · LinkedIn Classic · viewer-relative' : ''}</div>
      {preview.people && <>
        {preview.people.length === 0 ? <p>No visible people appeared on this page.</p> :
          <ol className={styles.people}>{preview.people.map(person => <li key={person.id}><strong>{person.name}</strong>{person.headline && <span>{person.headline}</span>}</li>)}</ol>}
      </>}
      {preview.note && <p>{preview.note}</p>}
      <button className={styles.tertiary} disabled={!!busy} onClick={() => void act('reset')}>Clear preview</button>
    </section>}
  </main>
}
