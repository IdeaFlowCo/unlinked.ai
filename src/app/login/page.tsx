import { Flex, Box, TextField, Button, Text, Heading, Container, Card } from '@radix-ui/themes';
import { loginOrSignup, signInWithGoogle } from './actions';
import { PersonIcon } from '@radix-ui/react-icons';

export default function AuthPage() {
    return (
        <Container size="1">
            <Flex direction="column" align="center" gap="6" py="9">
                <Box mb="4" style={{ textAlign: 'center' }}>
                    <PersonIcon width={40} height={40} />
                    <Heading size="8" mt="4">unlinked.ai</Heading>
                    <Text size="3" mt="2">
                        Semantic search for your LinkedIn network
                    </Text>
                </Box>

                <Card size="4" style={{ width: '100%' }}>
                    <form>
                        <Flex direction="column" gap="5">
                            <TextField.Root
                                size="3"
                                name="email"
                                type="email"
                                placeholder="Email address"
                                required
                            />

                            <TextField.Root
                                size="3"
                                name="password"
                                type="password"
                                placeholder="Password"
                                required
                            />

                            <Button
                                size="3"
                                variant="solid"
                                formAction={loginOrSignup}
                                style={{ width: '100%' }}
                            >
                                Continue
                            </Button>
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
                        <a href="/?skip=true" className="underline">
                            Skip to explore unlinked.ai
                        </a>
                    </Text>
                </Box>
            </Flex>
        </Container>
    );
}
