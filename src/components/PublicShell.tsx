import Link from 'next/link'
import { version } from '../../package.json'
import type { ReactNode } from 'react'

export default function PublicShell({ children }: { children: ReactNode }) {
  return <div className="public-site">
    <header className="public-header"><Link className="public-brand" href="/" aria-label="Unlinked home"><span className="brand-mark" aria-hidden="true">u.</span><span>unlinked</span></Link><nav aria-label="Main navigation"><Link href="/meet">Meet ↗</Link><Link href="/agents">For agents</Link><a href="https://www.unlinked.ai/login">Sign in</a></nav></header>
    {children}
    <footer className="public-footer"><span>unlinked.ai · <span className="app-version">v{version}</span></span><span>Your network. A little more within reach.</span></footer>
  </div>
}
