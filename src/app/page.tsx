// import { createClient } from '@/utils/supabase/server'
import { Container, Flex, Box, Button, Heading } from '@radix-ui/themes'
import { UploadIcon, PersonIcon } from '@radix-ui/react-icons'
import Link from 'next/link'

export default async function LandingPage() {
    return (
        <Container size="4">
            <Flex direction="column" gap="9">
                <Box mt={{ initial: '6', sm: '9' }} mb={{ initial: '6', sm: '9' }}>
                    <Flex direction="column" gap="6" align="center" style={{ textAlign: 'center' }}>
                        <Heading
                            size={{ initial: '8', sm: '9' }}
                            align="center"
                            style={{
                                background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                                WebkitBackgroundClip: 'text',
                                WebkitTextFillColor: 'transparent',
                                marginBottom: '8px'
                            }}
                        >
                            unlinked.ai
                        </Heading>
                        <Heading
                            size={{ initial: '3', sm: '4' }}
                            weight="regular"
                            color="gray"
                            style={{ maxWidth: '600px', lineHeight: '1.5' }}
                        >
                            your AI-powered supernetwork
                        </Heading>
                        <Flex
                            gap={{ initial: '3', sm: '4' }}
                            mt={{ initial: '4', sm: '6' }}
                            direction={{ initial: 'column', sm: 'row' }}
                            style={{ width: '100%', maxWidth: '500px' }}
                        >
                            <Button size="4" asChild style={{ flex: 1 }}>
                                <Link href="/onboarding" style={{ width: '100%' }}>
                                    LinkedIn Data
                                    <UploadIcon style={{ marginLeft: '8px' }} />
                                </Link>
                            </Button>
                            <Button size="4" asChild variant="soft" style={{ flex: 1 }}>
                                <Link href="/profiles" style={{ width: '100%' }}>
                                    Browse Profiles
                                    <PersonIcon style={{ marginLeft: '8px' }} />
                                </Link>
                            </Button>
                        </Flex>
                    </Flex>
                </Box>
            </Flex>
        </Container>
    )
}
