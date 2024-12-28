import { Card, Text, Flex, Avatar, Box } from '@radix-ui/themes'
import type { Database } from '@/utils/supabase/types'
import Link from 'next/link'

export type Profile = Database['public']['Tables']['profiles']['Row'] & {
  positions: (Database['public']['Tables']['positions']['Row'] & {
    companies: Database['public']['Tables']['companies']['Row'] | null
  })[]
  education: (Database['public']['Tables']['education']['Row'] & {
    institutions: Database['public']['Tables']['institutions']['Row'] | null
  })[]
}

interface ProfileListProps {
  profiles: Profile[]
}

export default function ProfileList({ profiles }: ProfileListProps) {
  return (
    <Flex direction="column" gap="3">
      {profiles.map(profile => {
        const currentPosition = profile.positions?.[0]
        const education = profile.education?.[0]

        return (
          <Card
            key={profile.id}
            size="2"
            asChild
          >
            <Link href={`/profiles/${profile.id}`}>
              <Flex gap="3">
                <Avatar
                  size="4"
                  fallback={`${profile.first_name?.[0]}${profile.last_name?.[0]}`}
                />
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="3" weight="bold">
                    {`${profile.first_name} ${profile.last_name}`.trim() || 'Unnamed Profile'}
                  </Text>
                  {profile.headline && (
                    <Text as="div" size="2" color="gray">
                      {profile.headline}
                    </Text>
                  )}
                  {currentPosition && (
                    <Text as="div" size="2" color="gray">
                      {currentPosition.title} at {currentPosition.companies?.name}
                    </Text>
                  )}
                  {education && (
                    <Text as="div" size="2" color="gray">
                      {education.degree_name} at {education.institutions?.name}
                      {education.finished_on && ` (${new Date(education.finished_on).getFullYear()})`}
                    </Text>
                  )}
                </Box>
              </Flex>
            </Link>
          </Card>
        )
      })}
    </Flex>
  )
}
