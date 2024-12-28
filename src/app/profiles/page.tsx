'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Container, Heading, Text, Card, Flex, Box } from '@radix-ui/themes'
import { PersonIcon } from '@radix-ui/react-icons'
import NetworkForceGraph from '@/components/NetworkForceGraph'
import SearchInput from '@/components/SearchInput'

export default function ProfilesIndex() {
  const [data, setData] = useState({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const loadData = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
      
      if (profilesError) throw profilesError

      const { data: connections, error: connectionsError } = await supabase
        .from('connections')
        .select('profile_id_a, profile_b(*), profile_a(*)')
      
      if (connectionsError) throw connectionsError

      // Transform data for the graph
      const nodes = profiles.map(profile => ({
        id: profile.id,
        name: `${profile.first_name} ${profile.last_name}`,
        type: 'person'
      }))

      const links = connections.map(conn => ({
        source: conn.profile_id_a,
        target: conn.profile_b.id
      }))

      setData({ nodes, links })
    } catch (e) {
      setError(e as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  if (loading) {
    return (
      <Container size="3">
        <Card size="4">
          <Flex direction="column" align="center" gap="3" py="8">
            <Heading size="6">Loading...</Heading>
          </Flex>
        </Card>
      </Container>
    )
  }

  if (error) {
    return (
      <Container size="3">
        <Card size="4">
          <Flex direction="column" align="center" gap="3" py="8">
            <Heading size="6" color="red">Error</Heading>
            <Text>{error.message}</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  return (
    <Container size="3">
      <Box mb="8">
        <Flex justify="between" align="center" mb="6">
          <Flex align="center" gap="3">
            <PersonIcon width="24" height="24" />
            <Heading size="7">Network Directory</Heading>
          </Flex>
          <Text size="3" color="gray">
            {data.nodes.length} professionals
          </Text>
        </Flex>

        <Card size="2">
          <Flex gap="3" align="center">
            <SearchInput 
              onSearch={async (query) => {
                // TODO: Implement search
                console.log('Search:', query)
              }}
              placeholder="Search professionals by name, title, or company..."
            />
          </Flex>
        </Card>
      </Box>

      <Card size="4" style={{ height: 'calc(100vh - 300px)' }}>
        <NetworkForceGraph data={data} />
      </Card>
    </Container>
  )
}
