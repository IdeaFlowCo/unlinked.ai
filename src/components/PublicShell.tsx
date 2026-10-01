import Link from 'next/link'
import type { ReactNode } from 'react'

export default function PublicShell({ children }: { children: ReactNode }) {
  return <div className="public-site">
    <header className="public-header"><Link className="public-brand" href="/" aria-label="Unlinked home"><span className="brand-mark" aria-hidden="true">u.</span><span>unlinked</span></Link><nav aria-label="Main navigation"><Link href="/network">My network</Link><Link href="/import-linkedin">Import</Link><Link href="/search">AI search</Link><Link href="/agents">Connect my agent</Link><Link href="/meet">Meet ↗</Link><Link href="/auth/login">Ideaflow ID sign-in</Link></nav></header>
    {children}
    <footer className="public-footer"><span>unlinked.ai</span><span>Your network. A little more within reach.</span></footer>
  </div>
}
