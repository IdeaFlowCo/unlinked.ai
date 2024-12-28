'use client'

import React from 'react'
import { Container, Heading, Text, Card, Box, Avatar, Flex } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/client'
import { useParams } from 'next/navigation'

export default function ProfileDetail() {
  const [profile, setProfile] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<Error | null>(null)
  const params = useParams()

  React.useEffect(() => {
    async function loadProfile() {
      try {
        const supabase = createClient()
        const { data, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', params.id)
          .single()

        if (profileError) throw profileError
        setProfile(data)
      } catch (e) {
        setError(e as Error)
      } finally {
        setLoading(false)
      }
    }

    loadProfile()
  }, [params.id])

  if (loading) {
    return (
      <Container size="3">
        <Card size="2">
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="3">Loading...</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  if (error) {
    return (
      <Container size="3">
        <Card size="2">
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="3" color="red">Error loading profile</Text>
            <Text size="2" color="gray">{error.message}</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  if (!profile) {
    return (
      <Container size="3">
        <Card size="2">
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="3" color="red">Profile not found</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  const fullName = `${profile.first_name} ${profile.last_name}`.trim()

  return (
    <Container size="3">
      <Card size="2">
        <Flex direction="column" gap="4" p="4">
          <Flex gap="4" align="center">
            <Avatar
              size="6"
              src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(fullName)}`}
              fallback={fullName[0]}
            />
            <Box>
              <Heading size="6">{fullName}</Heading>
              {profile.headline && (
                <Text size="3" color="gray">{profile.headline}</Text>
              )}
            </Box>
          </Flex>

          {profile.industry && (
            <Box>
              <Text weight="medium">Industry</Text>
              <Text>{profile.industry}</Text>
            </Box>
          )}

          {profile.summary && (
            <Box>
              <Text weight="medium">About</Text>
              <Text>{profile.summary}</Text>
            </Box>
          )}
        </Flex>
      </Card>
    </Container>
  )
}
