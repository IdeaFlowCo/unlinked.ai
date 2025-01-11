import { Container, Flex, Box, Button, Heading, TextField, Card } from '@radix-ui/themes'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function ResetPasswordPage() {
    async function updatePassword(formData: FormData) {
        'use server'

        const supabase = await createClient()
        const password = formData.get('password') as string

        const { error } = await supabase.auth.updateUser({
            password: password,
        })

        if (error) {
            return redirect(`/auth/reset-password?error=${encodeURIComponent(error.message)}`)
        }

        return redirect('/auth/login?message=Password updated successfully')
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
                </Box>

                <Card size="4" style={{ width: '100%' }}>
                    <form>
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
