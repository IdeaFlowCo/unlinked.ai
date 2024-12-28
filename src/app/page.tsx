// import { createClient } from '@/utils/supabase/server'
import { Container, Flex, Box, Button, Heading } from '@radix-ui/themes'
import { UploadIcon, PersonIcon } from '@radix-ui/react-icons'
import Link from 'next/link'

export default async function LandingPage() {
    return (
        <Container size="4">
            <Flex direction="column" gap="9">
                <Box mt="9">
                    <Flex direction="column" gap="5" align="center" style={{ textAlign: 'center' }}>
                        <Heading size="9" align="center">
                            unlinked.ai
                        </Heading>
                        <Heading size="4" weight="regular" color="gray">
                            your ai-powered supernetwork
                        </Heading>
                        <Flex gap="4" mt="4">
                            <Button size="4" asChild>
                                <Link href="/onboarding">
                                    Upload LinkedIn Data
                                    <UploadIcon />
                                </Link>
                            </Button>
                            <Button size="4" asChild variant="soft">
                                <Link href="/profiles">
                                    Browse Profiles
                                    <PersonIcon />
                                </Link>
                            </Button>
                        </Flex>
                    </Flex>
                </Box>
            </Flex>
        </Container>
    )
}
