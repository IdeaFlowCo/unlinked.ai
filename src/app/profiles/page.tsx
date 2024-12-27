import { createClient } from '@/utils/supabase/server'
import { Container, Heading, Text, Flex, Box } from '@radix-ui/themes'
import { PersonIcon } from '@radix-ui/react-icons'
import NetworkForceGraph from '@/components/NetworkForceGraph'
import SearchInput from '@/components/SearchInput'

export default async function ProfilesIndex() {
  try {
    const supabase = await createClient()
    
    // Fetch all necessary data in parallel
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

    // Check for any errors
    const errors = {
      profiles: profilesError,
      companies: companiesError,
      institutions: institutionsError,
      positions: positionsError,
      education: educationError,
      connections: connectionsError
    }

    const hasError = Object.entries(errors).find(([_, err]) => err)
    if (hasError) {
      const [source, err] = hasError
      console.error(`Error fetching ${source}:`, err)
      return (
        <Container size="3">
          <Heading size="7">Network Graph</Heading>
          <Text color="red">
            Database error: {err?.message || 'Unknown error occurred'}
          </Text>
          <Text size="2" color="gray">Please check server logs for details.</Text>
        </Container>
      )
    }

    // Transform data into graph structure
    const nodes = [
      // Profile nodes
      ...(profiles?.map(profile => ({
        id: `profile-${profile.id}`,
        name: `${profile.first_name} ${profile.last_name}`,
        type: 'person' as const,
        data: profile
      })) || []),
      
      // Company nodes
      ...(companies?.map(company => ({
        id: `company-${company.id}`,
        name: company.name,
        type: 'company' as const,
        data: company
      })) || []),
      
      // Institution nodes
      ...(institutions?.map(institution => ({
        id: `institution-${institution.id}`,
        name: institution.name,
        type: 'institution' as const,
        data: institution
      })) || [])
    ]

    const links = [
      // Profile-Profile connections
      ...(connections?.map(connection => ({
        source: `profile-${connection.profile_id_a}`,
        target: `profile-${connection.profile_id_b}`,
        type: 'connected_to' as const
      })) || []),
      
      // Profile-Company positions
      ...(positions?.map(position => ({
        source: `profile-${position.profile_id}`,
        target: `company-${position.company_id}`,
        type: 'works_at' as const
      })) || []),
      
      // Profile-Institution education
      ...(education?.map(edu => ({
        source: `profile-${edu.profile_id}`,
        target: `institution-${edu.institution_id}`,
        type: 'studied_at' as const
      })) || [])
    ]

    if (!nodes.length) {
      return (
        <Container size="3">
          <Heading size="7">Network Graph</Heading>
          <Text>No data found in the database.</Text>
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
              ({profiles?.length || 0} professionals, {companies?.length || 0} companies, {institutions?.length || 0} institutions)
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
  } catch (e) {
    console.error('Unexpected error:', e)
    return (
      <Container size="3">
        <Heading size="7">Profiles</Heading>
        <Text color="red">An unexpected error occurred.</Text>
        <Text size="2" color="gray">Error: {(e as Error).message}</Text>
      </Container>
    )
  }
}
