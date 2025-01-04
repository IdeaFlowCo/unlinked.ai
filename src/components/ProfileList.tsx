import { Card, Text, Flex, Avatar, Box, Badge } from '@radix-ui/themes'
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
            className="profile-card"
          >
            <Link href={`/profiles/${profile.id}`}>
              <Flex gap="4" p="3">
                <Avatar
                  size="5"
                  fallback={profile.full_name?.[0] || '?'}
                  style={{
                    border: '2px solid var(--accent-6)',
                    backgroundColor: 'var(--accent-2)'
                  }}
                />
                <Box style={{ flex: 1 }}>
                  <Flex gap="2" align="center" mb="1">
                    <Text as="div" size="3" weight="bold" style={{
                      background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent'
                    }}>
                      {profile.full_name?.trim() || 'Unnamed Profile'}
                    </Text>
                    {profile.is_shadow && (
                      <Badge size="1" variant="soft" color="gray">Shadow</Badge>
                    )}
                  </Flex>
                  {profile.headline && (
                    <Text as="div" size="2" color="gray" mb="1">
                      {profile.headline}
                    </Text>
                  )}
                  {currentPosition && (
                    <Flex align="center" gap="2" mb="1">
                      <Text as="div" size="2" color="gray">
                        {currentPosition.title} at {currentPosition.companies?.name}
                      </Text>
                    </Flex>
                  )}
                  {education && (
                    <Flex align="center" gap="2">
                      <Text as="div" size="2" color="gray">
                        {education.degree_name} at {education.institutions?.name}
                        {education.finished_on && ` (${new Date(education.finished_on).getFullYear()})`}
                      </Text>
                    </Flex>
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
