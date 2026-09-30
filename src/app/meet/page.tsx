import PublicShell from '@/components/PublicShell'
import MeetFlow from './MeetFlow'

export const metadata = {
  title: 'Meet someone · unlinked.ai',
  description: 'Scan or paste an OpenChat card and choose to send a friend request.',
}

export default function MeetPage() {
  return <PublicShell><main className="meet-main">
    <div className="meet-intro"><p className="eyebrow">A moment worth keeping</p><h1>Meet someone<span className="period">.</span></h1><p>Scan their OpenChat card. You’ll review it in OpenChat before choosing whether to send a friend request.</p></div>
    <MeetFlow />
    <aside className="availability-note" role="status"><strong>Unlinked network profiles are temporarily unavailable.</strong> The legacy backend is paused. This card handoff uses OpenChat.</aside>
  </main></PublicShell>
}
