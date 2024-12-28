'use client'
import React, { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Container, Text, Card, Flex, Box, Skeleton } from '@radix-ui/themes'
import SearchInput from '@/components/SearchInput'
import type { Profile } from '@/components/ProfileList'
import ProfileList from '@/components/ProfileList'

export default function ProfilesIndex() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const loadData = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: profilesError } = await supabase
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

      if (profilesError) throw profilesError
      setProfiles(data || [])
    } catch (e) {
      setError(e as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  if (error) {
    return (
      <Container size="3">
        <Card size="2">
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="3" color="red">Error loading data</Text>
            <Text size="2" color="gray">{error.message}</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  const filteredProfiles = profiles.filter(profile =>
    `${profile.first_name} ${profile.last_name}`
      .trim()
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  )

  return (
    <>
      <Box style={{
        position: 'sticky',
        top: '64px',
        backgroundColor: 'var(--color-background)',
        zIndex: 9,
        borderBottom: '1px solid var(--gray-4)',
        padding: '16px 0'
      }}>
        <Container size="3">
          <Flex gap="4" align="center">
            <Box style={{ flex: 1 }}>
              <SearchInput
                onSearch={async query => setSearchQuery(query)}
                placeholder="Search professionals by name..."
              />
            </Box>
          </Flex>
        </Container>
      </Box>
      <Container size="3">
        <Box style={{ height: 'calc(100vh - 140px)', marginTop: '16px' }}>
          <Skeleton loading={loading}>
            <ProfileList profiles={filteredProfiles} />
          </Skeleton>
        </Box>
        <Text size="2" color="gray" mt="2" align="center">
          {filteredProfiles.length} professionals
        </Text>
      </Container>
    </>
  )
}
