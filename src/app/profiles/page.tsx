'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Container, Text, Card, Flex, Box, SegmentedControl } from '@radix-ui/themes'
import { CustomGraphData, Node } from '@/types/graph'
import NetworkForceGraph from '@/components/NetworkForceGraph'
import SearchInput from '@/components/SearchInput'
import ProfileList from '@/components/ProfileList'

export default function ProfilesIndex() {
  const [data, setData] = useState<CustomGraphData>({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const [searchQuery, setSearchQuery] = useState('')

  const loadData = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
      
      if (profilesError) throw profilesError

      const { data: connections, error: connectionsError } = await supabase
        .from('connections')
        .select('profile_id_a, profile_id_b')
      
      if (connectionsError) throw connectionsError

      // Transform data for the graph
      const nodes = profiles.map(profile => ({
        id: profile.id,
        name: `${profile.first_name} ${profile.last_name}`,
        type: 'person' as const
      }))

      const links = connections.map(conn => ({
        source: conn.profile_id_a,
        target: conn.profile_id_b,
        type: 'connection' as const
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
            <Text size="3" color="red">Error loading data</Text>
            <Text size="2" color="gray">{error.message}</Text>
          </Flex>
        </Card>
      </Container>
    )
  }

  const filteredNodes = data.nodes.filter(node => 
    node.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredData = {
    nodes: filteredNodes,
    links: data.links.filter(link => 
      filteredNodes.some(n => n.id === link.source) && 
      filteredNodes.some(n => n.id === link.target)
    )
  }

  return (
    <Container size="3">
      <Box mb="4">
        <Card size="2">
          <Flex direction="column" gap="3">
            <SearchInput 
              onSearch={async (query) => {
                setSearchQuery(query)
              }}
              placeholder="Search professionals by name..."
            />
            <SegmentedControl.Root defaultValue={view} onValueChange={(value) => setView(value as 'graph' | 'list')}>
              <SegmentedControl.Item value="graph">Graph View</SegmentedControl.Item>
              <SegmentedControl.Item value="list">List View</SegmentedControl.Item>
            </SegmentedControl.Root>
          </Flex>
        </Card>
      </Box>

      <Card size="4" style={{ height: 'calc(100vh - 200px)' }}>
        {view === 'graph' ? (
          <NetworkForceGraph data={filteredData} />
        ) : (
          <ProfileList nodes={filteredNodes} />
        )}
      </Card>

      <Text size="2" color="gray" mt="2" align="center">
        {filteredNodes.length} professionals
      </Text>
    </Container>
  )
}
