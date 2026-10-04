import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import { LINKEDIN_EXPORT_URL } from '@/app/onboarding/types'

export default function ImportLinkedInPage() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="archive-title">
        <div className="hero-copy">
          <p className="eyebrow">Your existing network</p>
          <h1 id="archive-title">Bring your<br /><em>LinkedIn export.</em></h1>
          <p className="hero-subtitle">On a personal computer, in LinkedIn’s “Get a copy of your data” settings, choose the larger download for your complete archive. Full LinkedIn ZIP is preferred; a Connections-only export is also supported.</p>
          <ol className="export-instructions"><li>Choose the larger archive (recommended), or select Connections for a smaller export.</li><li>Wait for LinkedIn’s email. Unlinked cannot detect it.</li><li>Download within 3 days (72 hours) of LinkedIn’s email, then upload it here. Your saved file does not expire.</li></ol>
          <div className="hero-actions"><a className="public-button public-button-primary" href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer">Open LinkedIn export ↗</a></div>
          <p className="feature-caption">LinkedIn says the larger download arrives within 24 hours and currently lists Connections within 48 hours; delivery can vary. Its export feature is not available on mobile. <a href="https://www.linkedin.com/help/linkedin/answer/a1339364?lang=en" target="_blank" rel="noopener noreferrer">LinkedIn’s export guidance ↗</a></p>
        </div>
        <section className="landing-example" id="next" aria-labelledby="next-title">
          <p className="eyebrow">Next · private import</p><h2 id="next-title">Your file is ready?<br />Start here.</h2>
          <p>Sign in or create your account through Ideaflow ID, then upload your export. No invitation is required.</p>
          <aside className="availability-note" role="status"><strong>Open beta. No invitation needed.</strong> The link below takes you to sign-in at www.unlinked.ai.</aside>
          <div className="hero-actions"><a className="public-button public-button-primary" href="https://www.unlinked.ai/login">Sign in and upload →</a></div>
          <p className="feature-caption">In the app, confirm your account and review the upload disclosure before choosing your file. AI search and Agent setup follow your import.</p>
          <p className="feature-caption">Had an older Unlinked account? Legacy access remains paused; this page requires no action on that account.</p>
          <Link className="landing-text-link" href="/">Back to Unlinked →</Link>
        </section>
      </section>
    </main>
  </PublicShell>
}
