'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Container, Text, Card, Flex, Box } from '@radix-ui/themes'
import { Node } from '@/types/graph'
import SearchInput from '@/components/SearchInput'
import ProfileList from '@/components/ProfileList'

export default function ProfilesIndex() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const loadData = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
      
      if (profilesError) throw profilesError

      const profileNodes = profiles.map(profile => ({
        id: profile.id,
        name: `${profile.first_name} ${profile.last_name}`,
        type: 'person' as const
      }))

      setNodes(profileNodes)
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

  const filteredNodes = nodes.filter(node => 
    node.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <>
      <Box style={{ 
        position: 'sticky', 
        top: '64px', // Account for main header height
        backgroundColor: 'var(--color-background)', 
        zIndex: 9, // Below main header
        borderBottom: '1px solid var(--gray-4)',
        padding: '16px 0'
      }}>
        <Container size="3">
          <Flex gap="4" align="center">
            <Box style={{ flex: 1 }}>
              <SearchInput 
                onSearch={async (query) => {
                  setSearchQuery(query)
                }}
                placeholder="Search professionals by name..."
              />
            </Box>
          </Flex>
        </Container>
      </Box>

      <Container size="3">
        <Box style={{ height: 'calc(100vh - 140px)', marginTop: '16px' }}>
          <ProfileList nodes={filteredNodes} />
        </Box>

        <Text size="2" color="gray" mt="2" align="center">
          {filteredNodes.length} professionals
        </Text>
      </Container>
    </>
  )
}
