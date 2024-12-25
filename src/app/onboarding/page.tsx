'use client';

import { useState } from 'react';
import { Flex, Box, Button, Text, Heading } from '@radix-ui/themes';
import { supabase } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';
// Removed unused supabase import

export default function OnboardingPage() {
    const [isUploading, setIsUploading] = useState(false);
    const [countdown, setCountdown] = useState(300); // 5 minutes in seconds
    const [error, setError] = useState<string | null>(null);
    const [isComplete, setIsComplete] = useState(false);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) {
            return;
        }

        const file = e.target.files[0];
        if (file.type !== 'application/zip') {
            setError('Please upload a ZIP file containing your LinkedIn data export');
            return;
        }

        setIsUploading(true);
        setError(null);

        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/linkedin', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to upload file');
            }

            setIsUploading(false);
            startCountdown();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred during upload');
            setIsUploading(false);
        }
    };

    const startCountdown = () => {
        setCountdown(300); // 5 minutes in seconds
        const interval = setInterval(() => {
            setCountdown(prev => {
                if (prev <= 1) {
                    clearInterval(interval);
                    setIsComplete(true);
                    // Send email notification
                    supabase.auth.getUser().then(({ data: { user } }: { data: { user: User | null } }) => {
                        if (user?.email) {
                            supabase.functions.invoke('send-completion-email', {
                                body: { email: user.email }
                            });
                        }
                    });
                    return 0;
                }
                return prev - 1;
            });
        }, 1000); // Update every second
    };

    return (
        <Box p="9" style={{ maxWidth: '600px' }}>
            <Flex direction="column" gap="5">
                <Heading size="8">Upload Your LinkedIn Data</Heading>
                
                <Text size="3">
                    To get started, we need your LinkedIn data export. Follow these steps:
                </Text>

                <Box>
                    <Text as="div" size="2" mb="2">1. Go to LinkedIn and request your data export</Text>
                    <Text as="div" size="2" mb="2">2. Wait for the email from LinkedIn (usually within 10 minutes)</Text>
                    <Text as="div" size="2" mb="2">3. Download and unzip the export</Text>
                    <Text as="div" size="2">4. Upload the ZIP file here</Text>
                </Box>

                <Box
                    style={{
                        border: '2px dashed var(--gray-a5)',
                        borderRadius: 'var(--radius-3)',
                        padding: '24px',
                        textAlign: 'center'
                    }}
                >
                    <input
                        type="file"
                        accept=".zip"
                        onChange={handleFileUpload}
                        style={{ display: 'none' }}
                        id="file-upload"
                    />
                    <label htmlFor="file-upload">
                        <Box
                            as="span"
                            style={{
                                display: 'inline-block',
                                cursor: isUploading ? 'not-allowed' : 'pointer'
                            }}
                        >
                            <Button
                                size="3"
                                variant="surface"
                                disabled={isUploading}
                                style={{ width: '200px', height: '48px' }}
                            >
                                {isUploading ? 'Uploading...' : 'Choose File'}
                            </Button>
                        </Box>
                    </label>
                </Box>

                {error && (
                    <Text color="red" size="2">
                        {error}
                    </Text>
                )}

                {countdown > 0 && (
                    <Box className="text-center p-6 border rounded-lg">
                        <Heading size="5" mb="3">Processing Your LinkedIn Data</Heading>
                        <Text size="5" className="font-mono mb-3">
                            {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                        </Text>
                        <Text color="gray">
                            We&apos;ll send you an email when your data is ready
                        </Text>
                    </Box>
                )}

                {isComplete && (
                    <Box className="text-center p-6 border rounded-lg">
                        <Heading size="5" mb="3">Your Data is Ready!</Heading>
                        <Text color="gray" mb="4">
                            Your LinkedIn data has been processed successfully.
                            You can now explore your connections and profile.
                        </Text>
                        <Button size="3" onClick={() => window.location.href = '/profile'}>
                            View Your Profile
                        </Button>
                    </Box>
                )}

                {!countdown && !isComplete && !isUploading && !error && (
                    <Text size="2" color="gray">
                        Upload your LinkedIn data export ZIP file to get started.
                    </Text>
                )}
            </Flex>
        </Box>
    );
}
