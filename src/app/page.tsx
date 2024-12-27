// import { createClient } from '@/utils/supabase/server'
import { Container, Flex, Box, Text, Card, Grid, Button, Heading } from '@radix-ui/themes'
import { MagnifyingGlassIcon, UploadIcon, PersonIcon } from '@radix-ui/react-icons'

export default async function LandingPage() {
    // const supabase = await createClient()
    // const { data } = await supabase.auth.getUser()

    const features = [
        {
            title: 'Semantic Search',
            description: 'Search through LinkedIn profiles using natural language queries and semantic understanding.',
            icon: MagnifyingGlassIcon
        },
        {
            title: 'Easy Import',
            description: 'Simply upload your exported LinkedIn data to get started.',
            icon: UploadIcon
        },
        {
            title: 'Profile Analysis',
            description: 'Advanced analysis of professional profiles and connections.',
            icon: PersonIcon
        }
    ]

    return (
        <Container size="4">
            <Flex direction="column" gap="9">
                {/* Hero Section */}
                <Box mt="9">
                    <Flex direction="column" gap="5" align="center" style={{ textAlign: 'center' }}>
                        <Heading size="9" align="center">
                            unlinked.ai
                        </Heading>
                        <Text size="5" style={{ maxWidth: '600px' }}>
                            Semantic search for your LinkedIn network. Find the right connections using natural language.
                        </Text>
                        <Flex gap="4" mt="4">
                            <Button size="4">
                                Upload LinkedIn Data
                                <UploadIcon />
                            </Button>
                            <Button size="4" variant="outline">
                                Learn More
                            </Button>
                        </Flex>
                    </Flex>
                </Box>

                {/* Features Section */}
                <Grid columns={{ initial: '1', sm: '3' }} gap="5">
                    {features.map((feature) => (
                        <Card key={feature.title} size="3">
                            <Flex direction="column" gap="3">
                                <Box>
                                    <feature.icon width={24} height={24} />
                                </Box>
                                <Heading size="4">{feature.title}</Heading>
                                <Text>
                                    {feature.description}
                                </Text>
                            </Flex>
                        </Card>
                    ))}
                </Grid>

                {/* How It Works Section */}
                <Card size="4">
                    <Heading size="6" mb="4">How It Works</Heading>
                    <Grid columns="1" gap="4">
                        <Flex gap="4" align="center">
                            <Box>
                                <UploadIcon width={24} height={24} />
                            </Box>
                            <Text>1. Export your data from LinkedIn</Text>
                        </Flex>
                        <Flex gap="4" align="center">
                            <Box>
                                <UploadIcon width={24} height={24} />
                            </Box>
                            <Text>2. Upload your LinkedIn data to unlinked.ai</Text>
                        </Flex>
                        <Flex gap="4" align="center">
                            <Box>
                                <MagnifyingGlassIcon width={24} height={24} />
                            </Box>
                            <Text>3. Search your network using natural language</Text>
                        </Flex>
                    </Grid>
                </Card>

                {/* CTA Section */}
                <Box mb="9">
                    <Card size="3">
                        <Flex align="center" justify="between" gap="4" direction={{ initial: 'column', sm: 'row' }}>
                            <Box>
                                <Heading size="5" mb="2">Ready to explore your network?</Heading>
                                <Text>Start searching your LinkedIn connections semantically.</Text>
                            </Box>
                            <Button size="3">
                                Get Started
                                <UploadIcon />
                            </Button>
                        </Flex>
                    </Card>
                </Box>
            </Flex>
        </Container>
    )
}
