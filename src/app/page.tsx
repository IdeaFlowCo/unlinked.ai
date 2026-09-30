import Link from 'next/link'
import PublicShell from '@/components/PublicShell'

export default function Home() {
  return <PublicShell>
    <main className="public-main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">A better way to keep a connection</p>
          <h1 id="hero-title">Meet in person.<br /><em>Stay in touch.</em></h1>
          <p className="hero-subtitle">An introduction should be the start of a conversation. Scan an OpenChat card to connect with the person in front of you.</p>
          <div className="hero-actions">
            <Link className="public-button public-button-primary" href="/meet">Meet someone <span aria-hidden="true">↗</span></Link>
            <a className="public-button public-button-quiet" href="#how-it-works">How it works <span aria-hidden="true">↓</span></a>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="meet-node meet-node-a">you</div><div className="meet-node meet-node-b">someone<br />new</div>
          <div className="connection-line" />
          <div className="art-caption">one moment → a real connection</div>
        </div>
      </section>
      <section className="steps" id="how-it-works" aria-labelledby="steps-title">
        <div><p className="eyebrow">A simple handoff</p><h2 id="steps-title">From hello to connected.</h2></div>
        <ol>
          <li><span>01</span><div><h3>Ask for their card</h3><p>OpenChat cards are made to share face to face.</p></div></li>
          <li><span>02</span><div><h3>Scan or paste</h3><p>Use your camera, a card URL, or your phone’s Camera app.</p></div></li>
          <li><span>03</span><div><h3>Choose to connect</h3><p>Review the card in OpenChat, then send a friend request.</p></div></li>
        </ol>
      </section>
      <aside className="availability-note" role="status"><strong>Network profiles are temporarily unavailable.</strong> The legacy Unlinked network uses a paused backend. Meeting someone through an OpenChat card remains available.</aside>
    </main>
  </PublicShell>
}
