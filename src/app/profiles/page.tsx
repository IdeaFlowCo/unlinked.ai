import { createClient } from '@/utils/supabase/server'
import { Container, Heading, Text, Flex } from '@radix-ui/themes'
import { PersonIcon } from '@radix-ui/react-icons'
import ProfileGrid from '@/components/ProfileGrid'

export default async function ProfilesIndex() {
  try {
    const supabase = await createClient()
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .order('last_name')

    if (error) {
      console.error('Error fetching profiles:', error)
      return (
        <Container size="3">
          <Heading size="7">Profiles</Heading>
          <Text color="red">Database error: {error.message}</Text>
          <Text size="2" color="gray">Please check server logs for details.</Text>
        </Container>
      )
    }

    if (!profiles || profiles.length === 0) {
      return (
        <Container size="3">
          <Heading size="7">Profiles</Heading>
          <Text>No profiles found in the database.</Text>
          <Text size="2" color="gray">Environment: {process.env.NODE_ENV}</Text>
        </Container>
      )
    }

    return (
      <Container size="3">
        {/* Header with Network Directory */}
        <Flex gap="2" align="center" mb="6">
          <PersonIcon width="24" height="24" />
          <Heading size="6">Network Directory</Heading>
          <Text size="2" color="gray">({profiles.length} professionals)</Text>
        </Flex>

        {/* Client-side Profile Grid with Search */}
        <ProfileGrid profiles={profiles} />
      </Container>
    )
  } catch (e) {
    console.error('Unexpected error:', e)
    return (
      <Container size="3">
        <Heading size="7">Profiles</Heading>
        <Text color="red">An unexpected error occurred.</Text>
        <Text size="2" color="gray">Error: {(e as Error).message}</Text>
      </Container>
    )
  }
}
