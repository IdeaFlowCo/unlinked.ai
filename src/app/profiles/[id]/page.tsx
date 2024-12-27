import { createClient } from '@/utils/supabase/server'
import { Container, Heading, Text, Card, Flex } from '@radix-ui/themes'

export default async function ProfileDetail({
  params,
}: {
  params: { id: string }
}) {
  const supabase = await createClient()

  // Query the profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, headline, industry, summary')
    .eq('id', params.id)
    .single()

  // Query positions, education, skills
  const { data: positions } = await supabase
    .from('positions')
    .select('title, started_on, finished_on, companies ( name )')
    .eq('profile_id', params.id)

  const { data: education } = await supabase
    .from('education')
    .select('degree_name, started_on, finished_on, institutions ( name )')
    .eq('profile_id', params.id)

  const { data: skills } = await supabase
    .from('skills')
    .select('name')
    .eq('profile_id', params.id)

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
            <Text size="4">{pos.title} at {pos.companies?.name}</Text>
          </Card>
        ))}
      </Flex>

      {/* Education */}
      <Heading size="5" mt="5">Education</Heading>
      <Flex direction="column" gap="2">
        {education?.map((edu, index) => (
          <Card key={index}>
            <Text size="4">{edu.degree_name} at {edu.institutions?.name}</Text>
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
    </Container>
  )
}
