// components/header.tsx
import { Flex, Heading, Link, Button, Text, Box, Avatar, HoverCard } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import { signOut } from '@/app/auth/actions'
import { ExitIcon, PersonIcon, MagnifyingGlassIcon, EnterIcon, PlusIcon } from '@radix-ui/react-icons'

interface HeaderProps {
    showSearch?: boolean
}

export default async function Header({ showSearch = false }: HeaderProps) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Get the user's profile if they're logged in
    const { data: profile } = user ? await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('user_id', user.id)
        .single() : { data: null }

    return (
        <Box style={{
            borderBottom: '1px solid var(--gray-4)',
            backgroundColor: 'var(--color-background)',
            position: 'sticky',
            top: 0,
            zIndex: 10,
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            background: 'rgba(255, 255, 255, 0.8)'
        }}>
            <Flex
                px={{ initial: '4', sm: '6' }}
                py={{ initial: '3', sm: '4' }}
                justify="between"
                align="center"
                wrap="wrap"
                gap="4"
            >
                <Link href="/" className="no-underline hover-effect">
                    <Heading as="h1" size={{ initial: '5', sm: '6' }} style={{
                        background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent'
                    }}>
                        unlinked.ai
                    </Heading>
                </Link>
                {showSearch && (
                    <Box style={{ flex: 1, maxWidth: '600px', margin: '0 12px' }}>
                        <div id="search-container" style={{ width: '100%' }} />
                    </Box>
                )}
                <Flex align="center" gap={{ initial: '2', sm: '4' }}>
                    {user ? (
                        <Flex align="center" gap={{ initial: '2', sm: '4' }} wrap="wrap">
                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <Link href="/profiles">
                                        <Button size={{ initial: '3', sm: '3' }} variant="solid" style={{ width: '120px' }}>
                                            <MagnifyingGlassIcon width="16" height="16" />
                                        </Button>
                                    </Link>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Text as="div" weight="bold">browse profiles</Text>
                                    <Text as="div" color="gray" size="2">
                                        find your next connection
                                    </Text>
                                </HoverCard.Content>
                            </HoverCard.Root>

                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <Link href={`/profiles/${profile!.id}`} className="no-underline">
                                        <Button size={{ initial: '3', sm: '3' }} variant="soft" style={{ width: '60px' }}>
                                            <PersonIcon width="16" height="16" />
                                        </Button>
                                    </Link>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Flex gap="4">
                                        <Avatar
                                            size="3"
                                            fallback={profile?.full_name?.[0] || '?'}
                                            radius="full"
                                        />
                                        <Box>
                                            <Text as="div" weight="bold">
                                                {profile?.full_name || 'anonymous'}
                                            </Text>
                                            <Text as="div" color="gray" size="2">
                                                view and customize your profile
                                            </Text>
                                        </Box>
                                    </Flex>
                                </HoverCard.Content>
                            </HoverCard.Root>

                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <form>
                                        <Button size={{ initial: '3', sm: '3' }} variant="soft" formAction={signOut}>
                                            <ExitIcon width="16" height="16" />
                                        </Button>
                                    </form>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Text as="div" weight="bold">sign out</Text>
                                    <Text as="div" color="gray" size="2">
                                        see you next time!
                                    </Text>
                                </HoverCard.Content>
                            </HoverCard.Root>
                        </Flex>
                    ) : (
                        <Flex gap={{ initial: '2', sm: '4' }} wrap="wrap">
                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <Link href="/profiles">
                                        <Button size={{ initial: '3', sm: '3' }} variant="solid" style={{ width: '120px' }}>
                                            <MagnifyingGlassIcon width="16" height="16" />
                                        </Button>
                                    </Link>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Text as="div" weight="bold">browse profiles</Text>
                                    <Text as="div" color="gray" size="2">
                                        find your next connection
                                    </Text>
                                </HoverCard.Content>
                            </HoverCard.Root>

                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <Link href="/auth/login">
                                        <Button size={{ initial: '3', sm: '3' }} variant="soft">
                                            <EnterIcon width="16" height="16" />
                                        </Button>
                                    </Link>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Text as="div" weight="bold">sign in</Text>
                                    <Text as="div" color="gray" size="2">
                                        welcome back!
                                    </Text>
                                </HoverCard.Content>
                            </HoverCard.Root>

                            <HoverCard.Root>
                                <HoverCard.Trigger>
                                    <Link href="/auth/signup">
                                        <Button size={{ initial: '3', sm: '3' }} variant="soft">
                                            <PlusIcon width="16" height="16" />
                                        </Button>
                                    </Link>
                                </HoverCard.Trigger>
                                <HoverCard.Content size="2">
                                    <Text as="div" weight="bold">create account</Text>
                                    <Text as="div" color="gray" size="2">
                                        join the community
                                    </Text>
                                </HoverCard.Content>
                            </HoverCard.Root>
                        </Flex>
                    )}
                </Flex>
            </Flex>
        </Box>
    )
}
