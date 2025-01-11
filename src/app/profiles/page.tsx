import { createClient } from '@/utils/supabase/server'
import { Container } from '@radix-ui/themes'
import ProfilesContainer from './ProfilesContainer'

export default async function ProfilesPage() {
  const supabase = await createClient()

  // Only fetch first page of profiles on server
  const { data: initialProfiles } = await supabase
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

  return (
    <Container size="3">
      <ProfilesContainer initialProfiles={initialProfiles || []} />
    </Container>
  )
}
