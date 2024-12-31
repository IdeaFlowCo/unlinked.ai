// app/profiles/[id]/ProfileDetails.tsx
import { Card, Text, Avatar, Box, Flex, Heading, Badge, Separator } from '@radix-ui/themes'
import type { Database } from '@/utils/supabase/types'

type Profile = Database['public']['Tables']['profiles']['Row'] & {
    positions: (Database['public']['Tables']['positions']['Row'] & {
        companies: Database['public']['Tables']['companies']['Row'] | null
    })[]
    education: (Database['public']['Tables']['education']['Row'] & {
        institutions: Database['public']['Tables']['institutions']['Row'] | null
    })[]
    skills: Database['public']['Tables']['skills']['Row'][]
}

export default function ProfileDetails({ profile }: { profile: Profile }) {
    const fullName = `${profile.first_name} ${profile.last_name}`.trim()

    return (
        <Flex direction="column" gap="6">
            <Card size="4">
                <Flex gap="4" p="6">
                    <Avatar
                        size="6"
                        fallback={fullName[0]}
                    />
                    <Box>
                        <Flex align="center" gap="2" mb="1">
                            <Heading size="6">{fullName}</Heading>
                            {profile.is_shadow && (
                                <Badge variant="solid" color="gray">Shadow Profile</Badge>
                            )}
                        </Flex>
                        <Flex direction="column" gap="2">
                            <Text size="3" color="gray">{profile.headline}</Text>
                            {profile.summary && (
                                <Text size="2" color="gray">{profile.summary}</Text>
                            )}
                        </Flex>
                    </Box>
                </Flex>
            </Card>

            {profile.positions.length > 0 && (
                <Card size="2">
                    <Box p="5">
                        <Heading size="4" mb="4">Experience</Heading>
                        <Flex direction="column" gap="4">
                            {profile.positions.map((position, index) => (
                                <Box key={position.id}>
                                    <Text as="div" size="2" weight="bold">
                                        {position.title}
                                    </Text>
                                    <Text as="div" size="2" color="gray">
                                        {position.companies?.name}
                                    </Text>
                                    <Text as="div" size="2" color="gray">
                                        {position.started_on} - {position.finished_on || 'Present'}
                                    </Text>
                                    {index < profile.positions.length - 1 && (
                                        <Separator size="4" my="3" />
                                    )}
                                </Box>
                            ))}
                        </Flex>
                    </Box>
                </Card>
            )}

            {profile.education.length > 0 && (
                <Card size="2">
                    <Box p="5">
                        <Heading size="4" mb="4">Education</Heading>
                        <Flex direction="column" gap="4">
                            {profile.education.map((edu, index) => (
                                <Box key={edu.id}>
                                    <Text as="div" size="2" weight="bold">
                                        {edu.degree_name}
                                    </Text>
                                    <Text as="div" size="2" color="gray">
                                        {edu.institutions?.name}
                                    </Text>
                                    <Text as="div" size="2" color="gray">
                                        {edu.started_on} - {edu.finished_on || 'Present'}
                                    </Text>
                                    {index < profile.education.length - 1 && (
                                        <Separator size="4" my="3" />
                                    )}
                                </Box>
                            ))}
                        </Flex>
                    </Box>
                </Card>
            )}

            {profile.skills.length > 0 && (
                <Card size="2">
                    <Box p="5">
                        <Heading size="4" mb="4">Skills</Heading>
                        <Flex gap="2" wrap="wrap">
                            {profile.skills.map(skill => (
                                <Badge key={skill.id} variant="soft">
                                    {skill.name}
                                </Badge>
                            ))}
                        </Flex>
                    </Box>
                </Card>
            )}
        </Flex>
    )
}
