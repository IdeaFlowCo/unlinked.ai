import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import StartLinkedInExport from '@/components/StartLinkedInExport'

export default function Home() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Your network, remembered</p>
          <h1 id="hero-title">You already know<br /><em>someone.</em></h1>
          <p className="hero-subtitle">Find people in your LinkedIn connections by name, company, title and when you connected. A private network to ask, then share with your agent.</p>
          <div className="hero-actions"><StartLinkedInExport /></div>
          <p className="feature-caption">Start with Connections only. Nothing is uploaded here.</p>
          <Link className="landing-text-link" href="/import-linkedin#next">Already have your file? See the next step →</Link>
        </div>
        <aside className="landing-example" aria-label="Illustrative search answer">
          <p className="eyebrow">Example · fictional people</p>
          <h2>“Who do I know at a solar company in partnerships?”</h2>
          <article><span className="landing-initials" aria-hidden="true">AL</span><div><h3>Avery Lee</h3><p>Director of Partnerships<br />Northwind Solar · connected 2019</p><small>Matched on title and company</small></div></article>
          <p className="feature-caption">An example of the fields in a connections export, not a live search result. No contact biography or work history is inferred.</p>
        </aside>
      </section>
      <aside className="availability-note" role="status"><strong>Private import opens to invited guests first. Uploads and sign-in are not active yet.</strong> Download your file and keep it while the private journey is verified. This public site accepts no files. Meet remains available.</aside>
      <section className="steps" aria-labelledby="steps-title">
        <div><p className="eyebrow">One file. Your network.</p><h2 id="steps-title">From connections<br />to an answer.</h2><p className="section-copy">Request the export before login. An invitation and Ideaflow ID will be required before a private upload.</p></div>
        <ol>
          <li><span>01</span><div><h3>Get your connections</h3><p>Select Connections in LinkedIn’s data export. Download the file when LinkedIn emails you, and keep your copy.</p></div></li>
          <li><span>02</span><div><h3>Import privately, when invited</h3><p>Confirm your account before upload. The private journey must account for accepted, rejected and searchable connections before claiming readiness.</p></div></li>
          <li><span>03</span><div><h3>Ask, then connect your agent</h3><p>Search the selected import. Agent access is a separate, scoped choice. Both remain unavailable on this public site.</p></div></li>
        </ol>
      </section>
      <section className="meet-handoff" aria-labelledby="meet-title"><div><p className="eyebrow">Available today</p><h2 id="meet-title">Someone new?</h2><p>Scan an OpenChat card in person to continue the conversation.</p></div><Link className="public-button public-button-outline" href="/meet">Meet someone ↗</Link></section>
    </main>
  </PublicShell>
}
