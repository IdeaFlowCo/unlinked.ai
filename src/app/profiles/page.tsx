import { createClient } from '@/utils/supabase/server'
import { Container } from '@radix-ui/themes'
import ProfilesContainer from './ProfilesContainer'
import Link from 'next/link'

export default async function ProfilesPage() {
  const supabase = await createClient()

  // Only fetch first page of profiles on server
  const { data: initialProfiles, error } = await supabase
    .from('profiles')
    .select(`
      *,
      positions:positions(
        *,
        companies(*)
      ),
      education:education(
        *,
        institutions(*)
      )
    `)
    .order('created_at', { ascending: false })
    .range(0, 9)

  if (error) return <Container size="3"><div role="status" className="availability-note"><strong>Network profiles are temporarily unavailable.</strong> We could not reach the legacy profile service. This does not mean your network is empty. <Link href="/network">See network availability</Link> or <Link href="/">return to Unlinked</Link>.</div></Container>

  return (
    <Container size="3">
      <ProfilesContainer initialProfiles={initialProfiles || []} />
    </Container>
  )
}
