import { Flex, Box, TextField, Button, Text, Heading, Container, Card } from '@radix-ui/themes';
import { signup, signInWithGoogle } from '@/app/auth/actions';
import Link from 'next/link';

export default async function SignUpPage({
    searchParams
}: {
    searchParams: Promise<{ error?: string }>
}) {
    const params = await searchParams;
    const error = params.error;

    return (
        <Container size="1">
            <Flex direction="column" align="center" gap="6" py="9">
                <Box mb="4" style={{ textAlign: 'center' }}>
                    <Heading size="8" mt="4">unlinked.ai</Heading>
                    <Text size="3" mt="2">
                        your ai-powered supernetwork
                    </Text>
                </Box>

                <Card size="4" style={{ width: '100%' }}>
                    {error && (
                        <Box mb="4">
                            <Text size="2" color="red" weight="medium">
                                {decodeURIComponent(error)}
                            </Text>
                        </Box>
                    )}

                    <form>
                        <Flex direction="column" gap="5">
                            <TextField.Root
                                size="3"
                                type="text"
                                name="firstName"
                                placeholder="First Name"
                                required
                                autoComplete="given-name"
                            />

                            <TextField.Root
                                size="3"
                                type="text"
                                name="lastName"
                                placeholder="Last Name"
                                required
                                autoComplete="family-name"
                            />

                            <TextField.Root
                                size="3"
                                type="email"
                                name="email"
                                placeholder="Email address"
                                required
                                autoComplete="email"
                            />

                            <TextField.Root
                                size="3"
                                type="password"
                                name="password"
                                placeholder="Password"
                                required
                                autoComplete="new-password"
                            />

                            <TextField.Root
                                size="3"
                                type="url"
                                name="linkedInUrl"
                                placeholder="LinkedIn Profile URL (required)"
                                required
                            />

                            <Button
                                size="3"
                                variant="solid"
                                formAction={signup}
                                style={{ width: '100%' }}
                            >
                                Create Account
                            </Button>

                            <Link href="/auth/login" style={{ width: '100%' }}>
                                <Button
                                    size="3"
                                    variant="outline"
                                    style={{ width: '100%' }}
                                >
                                    Sign In Instead
                                </Button>
                            </Link>
                        </Flex>
                    </form>

                    <Box my="5">
                        <Flex align="center" gap="4">
                            <Box style={{ height: '1px', backgroundColor: 'var(--gray-a5)', flex: 1 }} />
                            <Text size="2">or continue with</Text>
                            <Box style={{ height: '1px', backgroundColor: 'var(--gray-a5)', flex: 1 }} />
                        </Flex>
                    </Box>

                    <form>
                        <Button
                            size="3"
                            variant="surface"
                            formAction={signInWithGoogle}
                            style={{ width: '100%' }}
                        >
                            Google
                        </Button>
                    </form>
                </Card>

                <Box style={{ textAlign: 'center' }}>
                    <Text size="2">
                        <Link href="/profiles" className="underline">
                            skip to explore unlinked.ai
                        </Link>
                    </Text>
                </Box>
            </Flex>
        </Container>
    );
}
