import { createClient } from '@/utils/supabase/server'
import { Container, Heading, Text, Card, Flex } from '@radix-ui/themes'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProfileDetail({ params }: PageProps) {
  const resolvedParams = await params
  const supabase = await createClient()

  // Query the profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, headline, industry, summary')
    .eq('id', resolvedParams.id)
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
    .eq('profile_id', resolvedParams.id)
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
    .eq('profile_id', resolvedParams.id)
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
    .eq('profile_id', resolvedParams.id)
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
    .or(`profile_id_a.eq.${resolvedParams.id},profile_id_b.eq.${resolvedParams.id}`)
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
      <Heading size="7">
        {profile.first_name} {profile.last_name}
      </Heading>
      <Text mt="2" size="4">
        {profile.headline}
      </Text>
      <Text mt="2" size="3" color="gray">
        {profile.industry}
      </Text>
      <Text mt="4" size="3">
        {profile.summary}
      </Text>

      {/* Positions */}
      <Heading size="5" mt="5">Positions</Heading>
      <Flex direction="column" gap="2">
        {positions?.map((pos, index) => (
          <Card key={index}>
            <Text size="4">{pos.title} at {pos.companies.name}</Text>
          </Card>
        ))}
      </Flex>

      {/* Education */}
      <Heading size="5" mt="5">Education</Heading>
      <Flex direction="column" gap="2">
        {education?.map((edu, index) => (
          <Card key={index}>
            <Text size="4">{edu.degree_name} at {edu.institutions.name}</Text>
          </Card>
        ))}
      </Flex>

      {/* Skills */}
      <Heading size="5" mt="5">Skills</Heading>
      <Flex gap="2" wrap="wrap">
        {skills?.map((sk, index) => (
          <Card key={index}>
            <Text>{sk.name}</Text>
          </Card>
        ))}
      </Flex>

      {/* Connections */}
      <Heading size="5" mt="5">Connections</Heading>
      <Flex direction="column" gap="2">
        {connections?.map((conn, index) => {
          const isA = conn.profile_id_a === resolvedParams.id
          const connectedProfile = isA ? conn.profile_b : conn.profile_a
          return (
            <Card key={index} asChild>
              <Link href={`/profiles/${connectedProfile.id}`}>
                <Text size="4">
                  {connectedProfile.first_name} {connectedProfile.last_name}
                </Text>
                {connectedProfile.headline && (
                  <Text size="2" color="gray">
                    {connectedProfile.headline}
                  </Text>
                )}
              </Link>
            </Card>
          )
        })}
      </Flex>
    </Container>
  )
}
