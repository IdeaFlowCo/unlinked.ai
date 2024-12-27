import { createClient } from '@/utils/supabase/server'
import { Database } from '@/utils/supabase/types'
import Link from 'next/link'
import { Container, Heading, Text, Card, Flex } from '@radix-ui/themes'

export default async function ProfilesIndex() {
  const supabase = await createClient()
  const { data: profiles } = await supabase
    .from('profiles')
    .select('*')
    .order('last_name')

  return (
    <Container size="3">
      <Heading size="7">Profiles</Heading>
      <Flex direction="column" gap="3" mt="4">
        {profiles?.map((p: Database['public']['Tables']['profiles']['Row']) => (
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
}
