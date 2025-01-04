// components/header.tsx
import { Flex, Heading, Link, Button, Text, Box } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import { signOut } from '@/app/auth/actions'

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
                            <Link href={`/profiles/${profile!.id}`} className="no-underline">
                                <Text size="2" color="gray">Hello {profile?.full_name || 'there'}</Text>
                            </Link>
                            <form>
                                <Button size="2" variant="soft" formAction={signOut}>
                                    Sign out
                                </Button>
                            </form>
                        </Flex>
                    ) : (
                        <Flex gap={{ initial: '2', sm: '4' }} wrap="wrap">
                            <Link href="/auth/login">
                                <Button size={{ initial: '2', sm: '3' }} variant="soft">
                                    Sign in
                                </Button>
                            </Link>
                            <Link href="/auth/signup">
                                <Button size={{ initial: '2', sm: '3' }} variant="solid">
                                    Create account
                                </Button>
                            </Link>
                        </Flex>
                    )}
                </Flex>
            </Flex>
        </Box>
    )
}
