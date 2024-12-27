'use client'

import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Container, Heading, Text, Flex, Box } from '@radix-ui/themes'
import { PersonIcon } from '@radix-ui/react-icons'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { Database } from '@/utils/supabase/types'

const NetworkForceGraph = dynamic(() => import('@/components/NetworkForceGraph'), { ssr: false })
const SearchInput = dynamic(() => import('@/components/SearchInput'), { ssr: false })

export default function ProfilesIndex() {
  const supabase = createClientComponentClient<Database>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [data, setData] = useState<{
    profiles: any[]
    companies: any[]
    institutions: any[]
    positions: any[]
    education: any[]
    connections: any[]
  }>({
    profiles: [],
    companies: [],
    institutions: [],
    positions: [],
    education: [],
    connections: []
  })

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [
      { data: profiles, error: profilesError },
      { data: companies, error: companiesError },
      { data: institutions, error: institutionsError },
      { data: positions, error: positionsError },
      { data: education, error: educationError },
      { data: connections, error: connectionsError }
    ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('companies').select('*'),
      supabase.from('institutions').select('*'),
      supabase.from('positions').select('*'),
      supabase.from('education').select('*'),
      supabase.from('connections').select('*')
    ])

        if (profilesError) throw profilesError
        if (companiesError) throw companiesError
        if (institutionsError) throw institutionsError
        if (positionsError) throw positionsError
        if (educationError) throw educationError
        if (connectionsError) throw connectionsError

        setData({
          profiles: profiles || [],
          companies: companies || [],
          institutions: institutions || [],
          positions: positions || [],
          education: education || [],
          connections: connections || []
        })
      } catch (e) {
        console.error('Error fetching data:', e)
        setError(e as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <Container size="3">
        <Heading size="7">Network Graph</Heading>
        <Text>Loading network data...</Text>
      </Container>
    )
  }

  if (error) {
    return (
      <Container size="3">
        <Heading size="7">Network Graph</Heading>
        <Text color="red">
          Database error: {error.message || 'Unknown error occurred'}
        </Text>
        <Text size="2" color="gray">Please check browser console for details.</Text>
      </Container>
    )
  }

    // Transform data into graph structure
    const nodes = [
      // Profile nodes
      ...(data.profiles?.map(profile => ({
        id: `profile-${profile.id}`,
        name: `${profile.first_name} ${profile.last_name}`,
        type: 'person' as const,
        data: profile
      })) || []),
      
      // Company nodes
      ...(data.companies?.map(company => ({
        id: `company-${company.id}`,
        name: company.name,
        type: 'company' as const,
        data: company
      })) || []),
      
      // Institution nodes
      ...(data.institutions?.map(institution => ({
        id: `institution-${institution.id}`,
        name: institution.name,
        type: 'institution' as const,
        data: institution
      })) || [])
    ]

    const links = [
      // Profile-Profile connections
      ...(data.connections?.map(connection => ({
        source: `profile-${connection.profile_id_a}`,
        target: `profile-${connection.profile_id_b}`,
        type: 'connected_to' as const
      })) || []),
      
      // Profile-Company positions
      ...(data.positions?.map(position => ({
        source: `profile-${position.profile_id}`,
        target: `company-${position.company_id}`,
        type: 'works_at' as const
      })) || []),
      
      // Profile-Institution education
      ...(data.education?.map(edu => ({
        source: `profile-${edu.profile_id}`,
        target: `institution-${edu.institution_id}`,
        type: 'studied_at' as const
      })) || [])
    ]

    if (!data.profiles.length) {
      return (
        <Container size="3">
          <Heading size="7">Network Graph</Heading>
          <Text>No profiles found in the database.</Text>
          <Text size="2" color="gray">Environment: {process.env.NODE_ENV}</Text>
        </Container>
      )
    }

    return (
      <Container size="3">
        <Box mb="6">
          <Flex gap="2" align="center" mb="4">
            <PersonIcon width="24" height="24" />
            <Heading size="6">Network Graph</Heading>
            <Text size="2" color="gray">
              ({data.profiles?.length || 0} professionals, {data.companies?.length || 0} companies, {data.institutions?.length || 0} institutions)
            </Text>
          </Flex>

          <SearchInput
            onSearch={async (query) => {
              try {
                const response = await fetch('/api/search', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ query })
                })

                if (!response.ok) {
                  const error = await response.json()
                  throw new Error(error.message || 'Search failed')
                }

                const { profiles: searchResults } = await response.json()
                // TODO: Update graph to highlight matching nodes once OpenAI integration is complete
                console.log('Search results:', searchResults)
              } catch (error) {
                console.error('Search error:', error)
                throw error
              }
            }}
            placeholder="Search professionals by name, title, or company..."
          />
        </Box>

        <NetworkForceGraph 
          data={{ nodes, links }} 
          width={1200}
          height={800}
          onNodeClick={(node) => {
            if (node.type === 'person') {
              window.location.href = `/profiles/${node.data.id}`
            }
          }}
        />
      </Container>
    )
    return (
      <Container size="3">
        <Box mb="6">
          <Flex gap="2" align="center" mb="4">
            <PersonIcon width="24" height="24" />
            <Heading size="6">Network Graph</Heading>
            <Text size="2" color="gray">
              ({data.profiles?.length || 0} professionals, {data.companies?.length || 0} companies, {data.institutions?.length || 0} institutions)
            </Text>
          </Flex>

          <SearchInput
            onSearch={async (query) => {
              try {
                const response = await fetch('/api/search', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ query })
                })

                if (!response.ok) {
                  const error = await response.json()
                  throw new Error(error.message || 'Search failed')
                }

                const { profiles: searchResults } = await response.json()
                // TODO: Update graph to highlight matching nodes once OpenAI integration is complete
                console.log('Search results:', searchResults)
              } catch (error) {
                console.error('Search error:', error)
                throw error
              }
            }}
            placeholder="Search professionals by name, title, or company..."
          />
        </Box>

        <NetworkForceGraph 
          data={{ nodes, links }} 
          width={1200}
          height={800}
          onNodeClick={(node) => {
            if (node.type === 'person') {
              window.location.href = `/profiles/${node.data.id}`
            }
          }}
        />
      </Container>
    )
}
