// app/profiles/[id]/page.tsx
import { Container, Grid, Box } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import ProfileDetails from './ProfileDetails'
import NetworkConnections from './NetworkConnections'

export default async function ProfileDetail({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [resolvedParams, supabase] = await Promise.all([params, createClient()])
  const { id } = resolvedParams

  // Fetch initial profile data
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*, positions(*, companies(*)), education(*, institutions(*)), skills(*)')
    .eq('id', id)
    .single()

  if (profileError || !profile) {
    return <div>Error or not found</div>
  }

  return (
    <Container size="4" pt="4">
      <Grid
        columns={{ initial: '1', md: '2' }}
        gap="6"
      >
        <Box>
          <ProfileDetails profile={profile} />
        </Box>
        <Box>
          <NetworkConnections profileId={id} />
        </Box>
      </Grid>
    </Container>
  )
}
