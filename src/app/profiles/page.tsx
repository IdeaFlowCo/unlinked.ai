'use client'

import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { Container, Heading, Text, Flex, Box, TextField, IconButton } from '@radix-ui/themes'
import { PersonIcon, MagnifyingGlassIcon, DotsHorizontalIcon } from '@radix-ui/react-icons'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { Database } from '@/utils/supabase/types'
import type { Node, Link, NodeWithData, BaseNode } from '../../types/graph'

type Profile = Database['public']['Tables']['profiles']['Row']

const NetworkForceGraph = dynamic(() => import('@/components/NetworkForceGraph'), { ssr: false })

export default function ProfilesIndex() {
  const supabase = createClientComponentClient<Database>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [data, setData] = useState<{
    profiles: Database['public']['Tables']['profiles']['Row'][]
    companies: Database['public']['Tables']['companies']['Row'][]
    institutions: Database['public']['Tables']['institutions']['Row'][]
    positions: Database['public']['Tables']['positions']['Row'][]
    education: Database['public']['Tables']['education']['Row'][]
    connections: Database['public']['Tables']['connections']['Row'][]
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
  }, [supabase])

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
    const nodes: Node[] = [
      // Profile nodes
      ...(data.profiles?.map(profile => {
        // Create base node that satisfies NodeObject constraints
        // Create node with base properties first
        const baseNode: BaseNode = {
          id: `profile-${profile.id}`,
          x: Math.random() * 1000,
          y: Math.random() * 1000,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null
        };

        // Add custom properties
        const node: Node = {
          ...baseNode,
          name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Unnamed Profile',
          type: 'person' as const
        };

        // Store profile data
        Object.assign(node, { __data: profile });
        
        return node;
      }) || []),
      
      // Company nodes
      ...(data.companies?.map(company => {
        const baseNode: BaseNode = {
          id: `company-${company.id}`,
          x: Math.random() * 1000,
          y: Math.random() * 1000,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null
        };

        const node: Node = {
          ...baseNode,
          name: company.name || 'Unnamed Company',
          type: 'company' as const
        };

        Object.assign(node, { __data: company });
        
        return node;
      }) || []),
      
      // Institution nodes
      ...(data.institutions?.map(institution => {
        const baseNode: BaseNode = {
          id: `institution-${institution.id}`,
          x: Math.random() * 1000,
          y: Math.random() * 1000,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null
        };

        const node: Node = {
          ...baseNode,
          name: institution.name || 'Unnamed Institution',
          type: 'institution' as const
        };

        Object.assign(node, { __data: institution });
        
        return node;
      }) || [])
    ]

    // Create a lookup map for nodes by ID
    const nodeMap = nodes.reduce<Record<string, Node>>((acc, node) => {
      if (node.id) {
        acc[node.id] = node;
      }
      return acc;
    }, {});

    const links: Link[] = [
      // Profile-Profile connections
      ...(data.connections?.map(connection => {
        const sourceId = `profile-${connection.profile_id_a}`;
        const targetId = `profile-${connection.profile_id_b}`;
        if (nodeMap[sourceId] && nodeMap[targetId]) {
          const link: Link = {
            source: nodeMap[sourceId],
            target: nodeMap[targetId],
            type: 'connection'
          };
          return link;
        }
        return null;
      }).filter((link): link is NonNullable<typeof link> => link !== null) || []),
      
      // Profile-Company positions
      ...(data.positions?.map(position => {
        const sourceId = `profile-${position.profile_id}`;
        const targetId = `company-${position.company_id}`;
        if (nodeMap[sourceId] && nodeMap[targetId]) {
          const link: Link = {
            source: nodeMap[sourceId],
            target: nodeMap[targetId],
            type: 'position'
          };
          return link;
        }
        return null;
      }).filter((link): link is NonNullable<typeof link> => link !== null) || []),
      
      // Profile-Institution education
      ...(data.education?.map(edu => {
        const sourceId = `profile-${edu.profile_id}`;
        const targetId = `institution-${edu.institution_id}`;
        if (nodeMap[sourceId] && nodeMap[targetId]) {
          const link: Link = {
            source: nodeMap[sourceId],
            target: nodeMap[targetId],
            type: 'education'
          };
          return link;
        }
        return null;
      }).filter((link): link is NonNullable<typeof link> => link !== null) || [])
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
      <>
        {/* Full viewport graph container */}
        <Box style={{ 
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 0,
          background: 'var(--gray-1)'
        }}>
          <NetworkForceGraph 
            data={{ nodes, links }} 
            height={typeof window !== 'undefined' ? window.innerHeight : 800}
            onNodeClick={(node) => {
              if (node.type === 'person') {
                const profileData = (node as NodeWithData).__data as Profile;
                window.location.href = `/profiles/${profileData.id}`
              }
            }}
          />
        </Box>

        {/* Floating search and stats container */}
        <Box style={{
          position: 'fixed',
          top: 'calc(64px + 1rem)', // Header height + spacing
          left: '50%',
          transform: 'translateX(-50%)',
          width: '95%',
          maxWidth: '1200px',
          zIndex: 1,
          padding: '1.5rem',
          background: 'rgba(255, 255, 255, 0.95)',
          backdropFilter: 'blur(12px)',
          borderRadius: 'var(--radius-4)',
          boxShadow: 'var(--shadow-5)'
        }}>
          <Flex gap="2" align="center" mb="4">
            <PersonIcon width="24" height="24" />
            <Heading size="6">Network Graph</Heading>
            <Text size="2" color="gray">
              ({data.profiles?.length || 0} professionals, {data.companies?.length || 0} companies, {data.institutions?.length || 0} institutions)
            </Text>
          </Flex>

          <Box style={{ width: '100%' }}>
            <TextField.Root 
              size="3"
              placeholder="Search professionals by name, title, or company..."
              onChange={async (e) => {
                try {
                  const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: e.target.value })
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
            >
              <TextField.Slot>
                <MagnifyingGlassIcon height="16" width="16" />
              </TextField.Slot>
              <TextField.Slot pr="3">
                <IconButton size="2" variant="ghost">
                  <DotsHorizontalIcon height="16" width="16" />
                </IconButton>
              </TextField.Slot>
            </TextField.Root>
          </Box>
        </Box>
      </>
    )
}
