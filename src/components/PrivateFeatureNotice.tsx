import Link from 'next/link'

export default function PrivateFeatureNotice({ title, description }: { title: string; description: string }) {
  return <main className="public-main"><section className="meet-intro"><p className="eyebrow">Your private Unlinked network</p><h1>{title}</h1><p>{description}</p></section><aside className="availability-note" role="status"><strong>This private feature is not available yet.</strong> Archive uploads and private account access remain closed while the service is restored. Existing accounts and archives are preserved; this page does not create or link an account.</aside><div className="hero-actions"><Link className="public-button public-button-primary" href="/import-linkedin">Prepare your LinkedIn archive</Link><Link className="public-button public-button-quiet" href="/">Back to Unlinked</Link><Link className="public-button public-button-quiet" href="/meet">Meet someone ↗</Link></div></main>
}
