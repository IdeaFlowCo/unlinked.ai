'use client';

import { Flex, Box, TextField, Button, Text, Heading } from '@radix-ui/themes';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { createClient } from '@/utils/supabase/client';

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
        console.log('Form submission started');
        console.log('Form data:', { email: formData.email });
        console.log('Window location:', window.location.href);
        console.log('Environment check:', {
            NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        });
        
        setLoading(true);
        setError(null);

        try {
            console.log('Creating Supabase client...');
            let supabase;
            try {
                supabase = createClient();
            } catch (clientError) {
                console.error('Failed to create Supabase client:', clientError);
                throw clientError;
            }
            
            console.log('Starting sign-in attempt with credentials:', {
                email: formData.email,
                passwordLength: formData.password.length
            });
            let signInData;
            let signInError;
            
            try {
                const result = await supabase.auth.signInWithPassword({
                    email: formData.email,
                    password: formData.password,
                });
                
                signInData = result.data;
                signInError = result.error;

                console.log('Sign in attempt result:', { 
                    success: !!signInData?.user,
                    error: signInError?.message || null,
                    response: signInData
                });

                if (signInError) {
                    console.error('Detailed sign in error:', {
                        message: signInError.message,
                        status: signInError.status,
                        name: signInError.name,
                        stack: signInError.stack
                    });
                }
            } catch (networkError) {
                console.error('Network or unexpected error during sign in:', networkError);
                throw networkError;
            }

            // If sign in fails due to invalid credentials, try sign up
            if (signInError?.message.includes('Invalid login credentials')) {
                console.log('Sign in failed, attempting sign up...');
                const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
                    email: formData.email,
                    password: formData.password,
                    options: {
                        emailRedirectTo: `${window.location.origin}/auth/callback`,
                    }
                });

                console.log('Sign up attempt result:', {
                    success: !!signUpData?.user,
                    error: signUpError?.message || null
                });

                if (signUpError) {
                    console.error('Sign up error:', signUpError);
                    throw signUpError;
                }
                
                if (!signUpData?.user) {
                    console.error('No user data returned from signup');
                    throw new Error('No user data returned from signup');
                }

                console.log('Sign up successful, redirecting to onboarding...');
                window.location.href = '/onboarding';
                return;
            }

            if (signInError) {
                console.error('Sign in error:', signInError);
                throw signInError;
            }
            
            if (!signInData?.user) {
                console.error('No user data returned from signin');
                throw new Error('No user data returned from signin');
            }

            console.log('Sign in successful, redirecting to profile...');
            window.location.href = '/profile';
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
            setLoading(false);
        }
    };

    const handleGoogleSignIn = async () => {
        try {
            const supabase = createClient();
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
                        <Box mb="4">
                            <Text color="red" size="2">
                                {error}
                            </Text>
                            {error.includes('check your email') && (
                                <Text size="2" style={{ marginTop: '8px' }}>
                                    Please check your email for confirmation instructions.
                                </Text>
                            )}
                        </Box>
                    )}

                    <Button
                        type="submit"
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
