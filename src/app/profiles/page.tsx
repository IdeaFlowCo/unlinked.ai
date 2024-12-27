import { createClient } from '@/utils/supabase/server'
import { Database } from '@/utils/supabase/types'
import Link from 'next/link'
import { Container, Heading, Text, Card, Flex } from '@radix-ui/themes'

export default async function ProfilesIndex() {
  try {
    console.log('Environment variables:', {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    })

    const supabase = await createClient()
    console.log('Supabase client created successfully')

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .order('last_name')
    
    console.log('Server-side profiles data:', profiles)
    console.log('Server-side error if any:', error)

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
        <Heading size="7">Profiles ({profiles.length})</Heading>
        <Flex direction="column" gap="3" mt="4">
          {profiles.map((p: Database['public']['Tables']['profiles']['Row']) => (
            <Card key={p.id}>
              <Link href={`/profiles/${p.id}`}>
                <Text>
                  {p.first_name} {p.last_name} - {p.headline}
                </Text>
              </Link>
            </Card>
          ))}
        </Flex>
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
