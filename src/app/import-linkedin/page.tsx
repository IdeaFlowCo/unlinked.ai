import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import { LINKEDIN_EXPORT_URL } from '@/app/onboarding/types'

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
          <p className="feature-caption">In LinkedIn, choose the larger data archive to include your connections, profile, positions, education and skills. Keep the original ZIP until private uploads open.</p>
          <div className="hero-actions">
            <a className="public-button public-button-primary" href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer">Request my LinkedIn export ↗</a>
            <Link className="public-button public-button-quiet" href="/auth/login">Ideaflow ID sign-in status</Link>
            <Link className="public-button public-button-quiet" href="/">Back to Unlinked</Link>
          </div>
        </div>
      </section>
    </main>
  </PublicShell>
}
