// components/header.tsx
import { Flex, Heading, Link, Button, Text, Box } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import { signOut } from '@/app/login/actions'

interface HeaderProps {
    showSearch?: boolean
}

export default async function Header({ showSearch = false }: HeaderProps) {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()

    return (
        <Box style={{
            borderBottom: '1px solid var(--gray-4)',
            backgroundColor: 'var(--color-background)',
            position: 'sticky',
            top: 0,
            zIndex: 10
        }}>
            <Flex px="4" py="2" justify="between" align="center">
                <Link href="/" className="no-underline">
                    <Heading as="h1" size="5">
                        unlinked.ai
                    </Heading>
                </Link>
                {showSearch && (
                    <Box style={{ flex: 1, maxWidth: '600px', margin: '0 24px' }}>
                        <div id="search-container" style={{ width: '100%' }} />
                    </Box>
                )}
                <Flex align="center" gap="4">
                    {data.user ? (
                        <Flex align="center" gap="4">
                            <Link href={`/profiles/${data.user.id}`} className="no-underline">
                                <Text size="2" color="gray">Hello {data.user.email || 'there'}</Text>
                            </Link>
                            <form>
                                <Button size="2" variant="soft" formAction={signOut}>
                                    Sign out
                                </Button>
                            </form>
                        </Flex>
                    ) : (
                        <Link href="/login">
                            <Button size="3" variant="soft">
                                Sign in
                            </Button>
                        </Link>
                    )}
                </Flex>
            </Flex>
        </Box>
    )
}
