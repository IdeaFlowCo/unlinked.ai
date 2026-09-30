import Link from 'next/link'
import type { ReactNode } from 'react'

export default function PublicShell({ children }: { children: ReactNode }) {
  return <div className="public-site">
    <header className="public-header"><Link className="public-brand" href="/" aria-label="Unlinked home"><span className="brand-mark" aria-hidden="true">u.</span><span>unlinked</span></Link><nav aria-label="Main navigation"><Link href="/meet">Meet someone <span aria-hidden="true">↗</span></Link></nav></header>
    {children}
    <footer className="public-footer"><span>unlinked.ai</span><span>Made for the people you meet. · v0.2.0</span></footer>
  </div>
}
