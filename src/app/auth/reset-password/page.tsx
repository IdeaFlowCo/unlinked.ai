import { Container, Flex, Box, Button, Heading, TextField, Text, Card } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

type SearchParams = { [key: string]: string | string[] | undefined }

export default async function ResetPasswordPage(props: { searchParams: Promise<SearchParams> }) {
    const searchParams = await props.searchParams;
    const errorParam = searchParams.error;
    const error = Array.isArray(errorParam) ? errorParam[0] : errorParam;

    // Check if we have a valid session
    const supabase = await createClient()
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.user) {
        return redirect('/auth/login?error=Please use the reset password link from your email')
    }

    async function updatePassword(formData: FormData) {
        'use server'

        const password = formData.get('password') as string
        const confirmPassword = formData.get('confirmPassword') as string

        if (password !== confirmPassword) {
            return redirect(`/auth/reset-password?error=${encodeURIComponent('Passwords do not match')}`)
        }

        const supabase = await createClient()
        const { error } = await supabase.auth.updateUser({
            password: password,
        })

        if (error) {
            return redirect(`/auth/reset-password?error=${encodeURIComponent(error.message)}`)
        }

        // Sign out after password change to require new login
        await supabase.auth.signOut()
        return redirect('/auth/login?message=Password updated successfully. Please sign in with your new password.')
    }

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
                        Reset Password
                    </Heading>
                    <Text size="3" mt="2" color="gray">
                        enter your new password below
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
                        <input
                            type="email"
                            name="email"
                            defaultValue={session.user.email || ''}
                            style={{ display: 'none' }}
                            autoComplete="username"
                        />
                        <Flex direction="column" gap="5">
                            <TextField.Root
                                size="3"
                                type="password"
                                name="password"
                                placeholder="new password"
                                required
                                autoComplete="new-password"
                            />

                            <TextField.Root
                                size="3"
                                type="password"
                                name="confirmPassword"
                                placeholder="confirm new password"
                                required
                                autoComplete="new-password"
                            />

                            <Button
                                size="3"
                                variant="solid"
                                formAction={updatePassword}
                                style={{ width: '100%' }}
                            >
                                Update Password
                            </Button>
                        </Flex>
                    </form>
                </Card>
            </Flex>
        </Container>
    )
} 
