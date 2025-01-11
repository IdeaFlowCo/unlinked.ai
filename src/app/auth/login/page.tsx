import { Container, Flex, Box, Button, Heading, TextField, Text, Card } from '@radix-ui/themes'
import Link from 'next/link'
import { login, signInWithGoogle, resetPassword } from '@/app/auth/actions'

type SearchParams = { [key: string]: string | string[] | undefined }

export default async function SignInPage(props: { searchParams: Promise<SearchParams> }) {
    const searchParams = await props.searchParams;
    const errorParam = searchParams.error;
    const messageParam = searchParams.message;
    const error = Array.isArray(errorParam) ? errorParam[0] : errorParam;
    const message = Array.isArray(messageParam) ? messageParam[0] : messageParam;

    return (
        <Container size="1">
            <Flex direction="column" align="center" gap="6" py="9">
                <Box mb="4" style={{ textAlign: 'center' }}>
                    <Heading
                        size="8"
                        style={{
                            background: 'linear-gradient(to right, var(--accent-9), var(--accent-11))',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                        }}
                    >
                        unlinked.ai
                    </Heading>
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
                    {message && (
                        <Box mb="4">
                            <Text size="2" color="green" weight="medium">
                                {decodeURIComponent(message)}
                            </Text>
                        </Box>
                    )}

                    <form>
                        <Flex direction="column" gap="5">
                            <TextField.Root
                                size="3"
                                type="email"
                                name="email"
                                placeholder="email address"
                                required
                                autoComplete="email"
                            />

                            <TextField.Root
                                size="3"
                                type="password"
                                name="password"
                                placeholder="password"
                                required
                                autoComplete="current-password"
                            />

                            <Button
                                size="2"
                                variant="ghost"
                                formAction={resetPassword}
                                formNoValidate
                                style={{ paddingRight: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 12, width: '100%', justifyContent: 'flex-start' }}
                            >
                                <Text size="2" color="gray">
                                    forgot password?
                                </Text>
                            </Button>

                            <Button
                                size="3"
                                variant="solid"
                                formAction={login}
                                style={{ width: '100%' }}
                            >
                                sign in
                            </Button>

                            <Link href="/auth/signup" style={{ width: '100%' }}>
                                <Button
                                    size="3"
                                    variant="outline"
                                    style={{ width: '100%' }}
                                >
                                    sign up instead
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
                            google
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
    )
}
