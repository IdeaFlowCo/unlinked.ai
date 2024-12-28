import { Container, Heading, Text, Card, Box, Avatar, Flex, Grid } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import Link from 'next/link'

export default async function ProfileDetail({
  params,
}: {
  params: { id: string }
}) {
  if (!params) {
    throw new Error('No params provided')
  }
  
  // Resolve params and create client at the beginning
  const [resolvedParams, supabase] = await Promise.all([
    params,
    createClient()
  ])
  const { id } = resolvedParams

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  const { data: positions, error: positionsError } = await supabase
    .from('positions')
    .select('*, companies(*)')
    .eq('profile_id', id)

  const { data: education, error: educationError } = await supabase
    .from('education')
    .select('*, institutions(*)')
    .eq('profile_id', id)

  const { data: skills, error: skillsError } = await supabase
    .from('skills')
    .select('*')
    .eq('profile_id', id)

  const { data: connects, error: connectsError } = await supabase
    .from('connections')
    .select('*, profile_b:profiles!connections_profile_id_b_fkey(*), profile_a:profiles!connections_profile_id_a_fkey(*)')
    .or(`profile_id_a.eq.${id},profile_id_b.eq.${id}`)

  if (profileError || positionsError || educationError || skillsError || connectsError) {
    return (
      <Container size="3">
        <Card size="2">
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="3" color="red">Error loading profile</Text>
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
          {/* Profile Header */}
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

          {/* Summary Section */}
          {profile.summary && (
            <Box>
              <Text weight="medium">About</Text>
              <Text>{profile.summary}</Text>
            </Box>
          )}

          {/* Two Column Layout */}
          <Grid columns="2" gap="4">
            {/* Left Column: Experience and Education */}
            <Flex direction="column" gap="4">
              {/* Experience Section */}
              <Box>
                <Heading size="4" mb="2">Experience</Heading>
                {positions?.map((position) => (
                  <Box key={position.id} mb="3">
                    <Text weight="medium">{position.title}</Text>
                    <Text color="gray">{position.companies?.name}</Text>
                    <Text size="2" color="gray">
                      {position.started_on} - {position.finished_on || 'Present'}
                    </Text>
                  </Box>
                ))}
              </Box>

              {/* Education Section */}
              <Box>
                <Heading size="4" mb="2">Education</Heading>
                {education?.map((edu) => (
                  <Box key={edu.id} mb="3">
                    <Text weight="medium">{edu.degree_name}</Text>
                    <Text color="gray">{edu.institutions?.name}</Text>
                    <Text size="2" color="gray">
                      {edu.started_on} - {edu.finished_on || 'Present'}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Flex>

            {/* Right Column: Skills and Network */}
            <Flex direction="column" gap="4">
              {/* Skills Section */}
              <Box>
                <Heading size="4" mb="2">Skills</Heading>
                <Flex gap="2" wrap="wrap">
                  {skills?.map((skill) => (
                    <Text key={skill.id} size="2" color="gray">
                      {skill.name}
                    </Text>
                  ))}
                </Flex>
              </Box>

              {/* Network Section */}
              <Box>
                <Heading size="4" mb="2">Network</Heading>
                <Flex direction="column" gap="2">
                  {connects?.map((conn) => {
                    const connectedProfile = conn.profile_id_a === id
                      ? conn.profile_b
                      : conn.profile_a
                    if (!connectedProfile) return null
                    const connName = `${connectedProfile.first_name} ${connectedProfile.last_name}`.trim()
                    return (
                      <Link href={`/profiles/${connectedProfile.id}`} key={connectedProfile.id}>
                        <Flex gap="2" align="center">
                          <Avatar
                            size="2"
                            src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(connName)}`}
                            fallback={connName[0]}
                          />
                          <Box>
                            <Text weight="medium">{connName}</Text>
                            {connectedProfile.headline && (
                              <Text size="2" color="gray">{connectedProfile.headline}</Text>
                            )}
                          </Box>
                        </Flex>
                      </Link>
                    )
                  })}
                </Flex>
              </Box>
            </Flex>
          </Grid>
        </Flex>
      </Card>
    </Container>
  )
}
