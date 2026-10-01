import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import { LINKEDIN_EXPORT_URL } from '@/app/onboarding/types'

export default function ImportLinkedInPage() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="archive-title">
        <div className="hero-copy">
          <p className="eyebrow">First, your export. Then, your account.</p>
          <h1 id="archive-title">Get your<br /><em>connections.</em></h1>
          <p className="hero-subtitle">On a personal computer, in LinkedIn’s “Get a copy of your data” settings, select Connections only and request the archive. You do not need the larger download for names, companies, titles and connection dates.</p>
          <ol className="export-instructions"><li>Select Connections and request your data.</li><li>Wait for LinkedIn’s email. Unlinked cannot detect it.</li><li>Download within 72 hours of the link arriving. Keep the original file.</li></ol>
          <div className="hero-actions"><a className="public-button public-button-primary" href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer">Open LinkedIn export ↗</a></div>
          <p className="feature-caption">LinkedIn currently lists Connections as available within 48 hours; actual delivery can vary. Its export feature is not available on mobile. <a href="https://www.linkedin.com/help/linkedin/answer/a1339364?lang=en" target="_blank" rel="noopener noreferrer">LinkedIn’s export guidance ↗</a></p>
        </div>
        <section className="landing-example" id="next" aria-labelledby="next-title">
          <p className="eyebrow">Next · private import</p><h2 id="next-title">Keep your file.<br />Use your invitation.</h2>
          <p>Login is the next step, and an invited Ideaflow ID account is required before upload. Open the invitation link supplied to you when the pilot is activated.</p>
          <aside className="availability-note" role="status"><strong>Sign-in and uploads are not active yet.</strong> Private service setup is in place, but the owner activation and verified end-to-end journey remain pending.</aside>
          <p>We cannot save your place or accept your file on this public page. There is no public signup or invitation request form.</p>
          <p className="feature-caption">Connections-only CSV and ZIP handling exists in the parser. The actual browser file-picker journey still needs verification before it is offered as supported upload.</p>
          <p className="feature-caption">Had an older Unlinked account? Legacy access remains paused; this page requires no action on that account.</p>
          <Link className="landing-text-link" href="/">Back to Unlinked →</Link>
        </section>
      </section>
    </main>
  </PublicShell>
}
