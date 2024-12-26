'use client';

import { Flex, Box, TextField, Button, Text, Heading } from '@radix-ui/themes';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';

interface FormData {
    email: string;
    password: string;
}

export default function AuthPage() {
    const [formData, setFormData] = useState<FormData>({
        email: '',
        password: '',
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData((prev) => ({
            ...prev,
            [name]: value,
        }));
    };

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            // First try to sign in
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                email: formData.email,
                password: formData.password,
            });

            // If sign in fails due to invalid user, try to sign up
            if (signInError?.message.includes('Invalid login credentials')) {
                const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
                    email: formData.email,
                    password: formData.password,
                });

                if (signUpError) throw signUpError;
                if (!signUpData?.user) throw new Error('No user data returned');

                window.location.href = '/onboarding';
                return;
            }

            if (signInError) throw signInError;
            if (!signInData?.user) throw new Error('No user data returned');

            window.location.href = '/profile';
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
            setLoading(false);
        }
    };

    const handleGoogleSignIn = async () => {
        try {
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: `${window.location.origin}/auth/callback`
                }
            });

            if (error) throw error;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        }
    };

    return (
        <Box p="9" style={{ maxWidth: '600px' }}>
            <form onSubmit={handleSubmit}>
                <Flex direction="column" gap="5">
                    <Heading size="8">Login or Create Account</Heading>

                    <TextField.Root
                        size="3"
                        name="email"
                        type="email"
                        placeholder="Your Email"
                        value={formData.email}
                        onChange={handleInputChange}
                        required
                    />

                    <TextField.Root
                        size="3"
                        name="password"
                        type="password"
                        placeholder="Your Password"
                        value={formData.password}
                        onChange={handleInputChange}
                        required
                    />

                    {error && (
                        <Text color="red" size="2">
                            {error}
                        </Text>
                    )}

                    <Button
                        size="3"
                        variant="surface"
                        disabled={loading}
                        style={{ width: '100%', height: '48px' }}
                    >
                        Continue
                    </Button>

                    <Box my="4">
                        <Box style={{ height: '1px', backgroundColor: 'var(--gray-a5)' }} />
                    </Box>

                    <Button
                        size="3"
                        variant="outline"
                        onClick={handleGoogleSignIn}
                        style={{ width: '100%', height: '48px' }}
                    >
                        Sign in with Google
                    </Button>

                    <Box style={{ marginTop: '80px' }}>
                        <Text>
                            <a href="/" className="underline">Skip to AI LinkedIn</a>
                        </Text>
                    </Box>
                </Flex>
            </form>
        </Box>
    );
}
