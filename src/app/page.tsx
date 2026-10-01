import Link from 'next/link'
import PublicShell from '@/components/PublicShell'

export default function Home() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Your network, remembered</p>
          <h1 id="hero-title">You already know<br /><em>someone.</em></h1>
          <p className="hero-subtitle">Find people in your LinkedIn connections by name, company, title and when you connected. A private network to ask, then share with your agent.</p>
          <div className="hero-actions"><a className="public-button public-button-primary" href="https://private.unlinked.ai/login">Start →</a></div>
          <p className="feature-caption">Sign in or create your account, then upload your LinkedIn export. Full ZIP preferred; Connections-only also supported.</p>
          <Link className="landing-text-link" href="/import-linkedin">Need your export? Get it from LinkedIn →</Link>
        </div>
        <aside className="landing-example" aria-label="Illustrative search answer">
          <p className="eyebrow">Example · fictional people</p>
          <h2>“Who do I know at a solar company in partnerships?”</h2>
          <article><span className="landing-initials" aria-hidden="true">AL</span><div><h3>Avery Lee</h3><p>Director of Partnerships<br />Northwind Solar · connected 2019</p><small>Matched on title and company</small></div></article>
          <p className="feature-caption">An example of the fields in a connections export, not a live search result. No contact biography or work history is inferred.</p>
        </aside>
      </section>
      <aside className="availability-note" role="status"><strong>Open beta. No invitation needed.</strong> Sign-in, upload, AI search and Agent setup currently run at private.unlinked.ai. The Start and Sign in links take you there; this homepage remains on www.unlinked.ai.</aside>
      <section className="steps" aria-labelledby="steps-title">
        <div><p className="eyebrow">One file. Your network.</p><h2 id="steps-title">From connections<br />to an answer.</h2><p className="section-copy">Bring your export, sign in with your chosen account, and review your import before asking a question.</p></div>
        <ol>
          <li><span>01</span><div><h3>Get your connections</h3><p>Request the complete LinkedIn data archive. Connections-only is also supported. Download the file when LinkedIn emails you, and keep your copy.</p></div></li>
          <li><span>02</span><div><h3>Sign in and upload</h3><p>Choose your account through Ideaflow ID. Upload your full ZIP or Connections-only file and review the import receipt.</p></div></li>
          <li><span>03</span><div><h3>Ask, then connect your agent</h3><p>Ask AI about your own network. Open Agent setup in the app to connect your MCP client; agent access is a separate choice.</p></div></li>
        </ol>
      </section>
      <section className="meet-handoff" aria-labelledby="meet-title"><div><p className="eyebrow">Available today</p><h2 id="meet-title">Someone new?</h2><p>Scan an OpenChat card in person to continue the conversation.</p></div><Link className="public-button public-button-outline" href="/meet">Meet someone ↗</Link></section>
    </main>
  </PublicShell>
}
