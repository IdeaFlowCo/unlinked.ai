import Link from 'next/link'
import PublicShell from '@/components/PublicShell'

export default function ImportLinkedInPage() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="archive-title">
        <div className="hero-copy">
          <p className="eyebrow">Your existing network</p>
          <h1 id="archive-title">Import LinkedIn<br /><em>archive.</em></h1>
          <p className="hero-subtitle">Bring your exported connections into a private network, then find the people you need.</p>
          <aside className="availability-note" role="status">
            <strong>Archive import is temporarily unavailable.</strong> Private ingestion and search are being restored. Uploads are closed until the private service is ready. Keep your original LinkedIn archive; there is no need to upload it elsewhere.
          </aside>
          <div className="hero-actions">
            <Link className="public-button public-button-primary" href="/meet">Meet someone <span aria-hidden="true">↗</span></Link>
            <Link className="public-button public-button-quiet" href="/">Back to Unlinked</Link>
          </div>
        </div>
      </section>
    </main>
  </PublicShell>
}
