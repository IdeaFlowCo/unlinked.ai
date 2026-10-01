import Link from 'next/link'
import PublicShell from '@/components/PublicShell'

export default function Home() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">The people you already know</p>
          <h1 id="hero-title">Your network.<br /><em>Within reach.</em></h1>
          <p className="hero-subtitle">Bring your LinkedIn connections together. Find the right person with AI, revisit your own profile, and give your agent a private window into your network.</p>
          <div className="hero-actions">
            <Link className="public-button public-button-primary" href="/import-linkedin">Import LinkedIn archive →</Link>
            <Link className="public-button public-button-quiet" href="/auth/login">Ideaflow ID sign-in</Link>
          </div>
          <p className="feature-caption">Private network access is being restored. Upload and sign-in availability below.</p>
        </div>
        <div className="network-art" aria-hidden="true">
          <p className="eyebrow">A network, remembered</p>
          <div className="network-question">Who do I know<br />who can help?</div>
          <div className="network-thread"><span>your connections</span><span>their experience</span><span>the right introduction</span></div>
          <div className="network-center">you</div>
          <p className="art-caption">people first · private by design</p>
        </div>
      </section>
      <aside className="availability-note" role="status"><strong>Private sign-in, archive uploads, browsing and AI search are not available yet.</strong> We are restoring the complete private journey. You can request your LinkedIn archive now, and Meet remains available today. No archive upload is accepted on this public site.</aside>
      <section className="steps" id="how-it-works" aria-labelledby="steps-title">
        <div><p className="eyebrow">Your network, on your terms</p><h2 id="steps-title">From an archive<br />to an answer.</h2><p className="section-copy">The private journey we are restoring starts with the network you have already built.</p></div>
        <ol>
          <li><span>01</span><div><h3><Link href="/import-linkedin">Bring your network</Link></h3><p>Request your full LinkedIn archive, including connections, profile and experience. Keep the original ZIP.</p></div></li>
          <li><span>02</span><div><h3><Link href="/network">Browse and find people</Link></h3><p>Revisit contacts and your own imported profile. Ask AI who fits the experience you need.</p></div></li>
          <li><span>03</span><div><h3><Link href="/agents">Connect your agent</Link></h3><p>Choose a scoped MCP setup for private search, with access you can revoke.</p></div></li>
        </ol>
      </section>
      <section className="meet-handoff" aria-labelledby="meet-title"><div><p className="eyebrow">Available today</p><h2 id="meet-title">Someone new?</h2><p>Scan an OpenChat card in person to continue the conversation. Meet is here alongside your existing network.</p></div><Link className="public-button public-button-outline" href="/meet">Meet someone ↗</Link></section>
    </main>
  </PublicShell>
}
