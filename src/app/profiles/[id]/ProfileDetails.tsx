// app/profiles/[id]/ProfileDetails.tsx
'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, Text, Avatar, Box, Flex, Heading, Badge, Separator, Button, HoverCard } from '@radix-ui/themes'
import type { Database } from '@/utils/supabase/types'
import { useRouter } from 'next/navigation'
import EditProfileForm from './EditProfileForm'
import { createClient } from '@/utils/supabase/client'
import { Pencil2Icon } from '@radix-ui/react-icons'

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
    const [isEditing, setIsEditing] = useState(false)
    const [currentUser, setCurrentUser] = useState<string | null>(null)
    const hasCheckedUser = useRef(false)
    const router = useRouter()
    const supabase = createClient()

    // Check if the current user owns this profile
    useEffect(() => {
        if (!hasCheckedUser.current) {
            const checkUser = async () => {
                const { data: { user } } = await supabase.auth.getUser()
                setCurrentUser(user?.id || null)
                hasCheckedUser.current = true
            }
            checkUser()
        }
    }, [])

    const fullName = profile.full_name?.trim() || 'Unnamed Profile'
    const canEdit = currentUser === profile.user_id

    const handleSave = () => {
        setIsEditing(false)
        router.refresh()
    }

    if (isEditing) {
        return <EditProfileForm profile={profile} onCancel={() => setIsEditing(false)} onSave={handleSave} />
    }

    return (
        <Flex direction="column" gap="6">
            <Card size="4" className="profile-hero-card">
                <Flex gap="6" p="6">
                    <Avatar
                        size="7"
                        fallback={fullName.charAt(0).toUpperCase()}
                        style={{
                            border: '3px solid var(--accent-6)',
                            backgroundColor: 'var(--accent-2)'
                        }}
                    />
                    <Box style={{ flex: 1 }}>
                        <Flex align="center" gap="3" mb="2" justify="between">
                            <Flex align="center" gap="3">
                                <Heading size="6" style={{
                                    background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                                    WebkitBackgroundClip: 'text',
                                    WebkitTextFillColor: 'transparent'
                                }}>
                                    {fullName}
                                </Heading>
                                {!profile.user_id && (
                                    <Badge size="1" variant="soft" color="gray">
                                        Shadow
                                    </Badge>
                                )}
                            </Flex>
                            {canEdit && (
                                <HoverCard.Root>
                                    <HoverCard.Trigger>
                                        <Button
                                            size={{ initial: '3', sm: '3' }}
                                            variant="soft"
                                            style={{ width: '60px' }}
                                            onClick={() => setIsEditing(true)}
                                        >
                                            <Pencil2Icon width="16" height="16" />
                                        </Button>
                                    </HoverCard.Trigger>
                                    <HoverCard.Content size="2">
                                        <Text as="div" weight="bold">edit profile</Text>
                                        <Text as="div" color="gray" size="2">
                                            customize your profile
                                        </Text>
                                    </HoverCard.Content>
                                </HoverCard.Root>
                            )}
                        </Flex>
                        <Flex direction="column" gap="2">
                            <Text size="3" weight="medium" color="gray">{profile.headline}</Text>
                            {profile.summary && (
                                <Text size="2" color="gray" style={{ lineHeight: '1.6' }}>
                                    {profile.summary}
                                </Text>
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
                                    <Text as="div" size="2" color="gray" style={{ lineHeight: '1.6', marginTop: 'var(--space-2)' }}>
                                        {position.description}
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
