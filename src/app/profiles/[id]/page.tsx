import { createClient } from '@/utils/supabase/server'
import { Container, Heading, Text, Card, Flex, Box, Grid, Avatar, Badge } from '@radix-ui/themes'
import { BackpackIcon as BriefcaseIcon, StarIcon, PersonIcon as UsersIcon, BookmarkIcon } from '@radix-ui/react-icons'
import Link from 'next/link'

interface PageProps {
  params?: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function ProfileDetail({ params }: PageProps) {
  const supabase = await createClient()
  const resolvedParams = await params
  const id = resolvedParams?.id

  // Query the profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, headline, industry, summary')
    .eq('id', id)
    .single()

  // Query positions, education, skills
  const { data: positions } = await supabase
    .from('positions')
    .select(`
      title,
      started_on,
      finished_on,
      companies (
        name
      )
    `)
    .eq('profile_id', id)
    .returns<{
      title: string;
      started_on: string;
      finished_on: string | null;
      companies: { name: string };
    }[]>()

  const { data: education } = await supabase
    .from('education')
    .select(`
      degree_name,
      started_on,
      finished_on,
      institutions (
        name
      )
    `)
    .eq('profile_id', id)
    .returns<{
      degree_name: string;
      started_on: string;
      finished_on: string | null;
      institutions: { name: string };
    }[]>()

  const { data: skills } = await supabase
    .from('skills')
    .select(`
      name
    `)
    .eq('profile_id', id)
    .returns<{
      name: string;
    }[]>()

  // Query connections
  const { data: connections } = await supabase
    .from('connections')
    .select(`
      profile_id_a,
      profile_id_b,
      profile_a:profiles!connections_profile_id_a_fkey (
        id,
        first_name,
        last_name,
        headline
      ),
      profile_b:profiles!connections_profile_id_b_fkey (
        id,
        first_name,
        last_name,
        headline
      )
    `)
    .or(`profile_id_a.eq.${id},profile_id_b.eq.${id}`)
    .returns<{
      profile_id_a: string;
      profile_id_b: string;
      profile_a: {
        id: string;
        first_name: string;
        last_name: string;
        headline: string;
      };
      profile_b: {
        id: string;
        first_name: string;
        last_name: string;
        headline: string;
      };
    }[]>()

  if (!profile) {
    return (
      <Container size="2">
        <Heading size="6">Profile Not Found</Heading>
      </Container>
    )
  }

  return (
    <Container size="3">
      {/* Profile Header */}
      <Card size="4" mb="6">
        <Flex direction="column" align="start" gap="5">
          <Flex gap="4" align="center" width="100%">
            <Avatar
              size="7"
              src={`https://api.dicebear.com/7.x/initials/svg?seed=${profile.first_name} ${profile.last_name}`}
              fallback={`${profile.first_name[0]}${profile.last_name[0]}`}
              radius="full"
            />
            <Box>
              <Heading size="7">
                {profile.first_name} {profile.last_name}
              </Heading>
              <Text size="4" color="gray" mt="1">
                {profile.headline}
              </Text>
            </Box>
          </Flex>

          <Badge size="2" variant="soft">{profile.industry}</Badge>

          {profile.summary && (
            <Text size="3" style={{ lineHeight: '1.5' }}>
              {profile.summary}
            </Text>
          )}
        </Flex>
      </Card>

      <Grid columns={{ initial: '1', md: '2' }} gap="6">
        {/* Left Column */}
        <Box>
          {/* Positions */}
          <Card size="3" mb="6">
            <Flex gap="2" align="center" mb="4">
              <BriefcaseIcon width="20" height="20" />
              <Heading size="4">Experience</Heading>
            </Flex>
            <Flex direction="column" gap="4">
              {positions?.map((pos, index) => (
                <Card key={index} size="2" variant="surface">
                  <Box>
                    <Heading size="3">{pos.title}</Heading>
                    <Text size="3" color="gray" mt="1">{pos.companies.name}</Text>
                    <Text size="2" color="gray" mt="1">
                      {pos.started_on} - {pos.finished_on || 'Present'}
                    </Text>
                  </Box>
                </Card>
              ))}
            </Flex>
          </Card>

          {/* Education */}
          <Card size="3">
            <Flex gap="2" align="center" mb="4">
              <BookmarkIcon width="20" height="20" />
              <Heading size="4">Education</Heading>
            </Flex>
            <Flex direction="column" gap="4">
              {education?.map((edu, index) => (
                <Card key={index} size="2" variant="surface">
                  <Box>
                    <Heading size="3">{edu.degree_name}</Heading>
                    <Text size="3" color="gray" mt="1">{edu.institutions.name}</Text>
                    <Text size="2" color="gray" mt="1">
                      {edu.started_on} - {edu.finished_on || 'Present'}
                    </Text>
                  </Box>
                </Card>
              ))}
            </Flex>
          </Card>
        </Box>

        {/* Right Column */}
        <Box>
          {/* Skills */}
          <Card size="3" mb="6">
            <Flex gap="2" align="center" mb="4">
              <StarIcon width="20" height="20" />
              <Heading size="4">Skills</Heading>
            </Flex>
            <Flex gap="2" wrap="wrap">
              {skills?.map((skill, index) => (
                <Badge key={index} size="2" variant="soft">
                  {skill.name}
                </Badge>
              ))}
            </Flex>
          </Card>

          {/* Connections */}
          <Card size="3">
            <Flex gap="2" align="center" mb="4">
              <UsersIcon width="20" height="20" />
              <Heading size="4">Network</Heading>
            </Flex>
            <Flex direction="column" gap="3">
              {connections?.map((conn, index) => {
                const isA = conn.profile_id_a === id
                const connectedProfile = isA ? conn.profile_b : conn.profile_a
                return (
                  <Card key={index} asChild variant="surface">
                    <Link href={`/profiles/${connectedProfile.id}`}>
                      <Flex gap="3" align="center">
                        <Avatar
                          size="3"
                          src={`https://api.dicebear.com/7.x/initials/svg?seed=${connectedProfile.first_name} ${connectedProfile.last_name}`}
                          fallback={`${connectedProfile.first_name[0]}${connectedProfile.last_name[0]}`}
                          radius="full"
                        />
                        <Box>
                          <Text size="2" weight="medium">
                            {connectedProfile.first_name} {connectedProfile.last_name}
                          </Text>
                          {connectedProfile.headline && (
                            <Text size="2" color="gray" style={{ lineHeight: '1.3' }}>
                              {connectedProfile.headline}
                            </Text>
                          )}
                        </Box>
                      </Flex>
                    </Link>
                  </Card>
                )
              })}
            </Flex>
          </Card>
        </Box>
      </Grid>
    </Container>
  )
}
