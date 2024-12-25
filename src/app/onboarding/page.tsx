'use client';

import { useState } from 'react';
import { Flex, Box, Button, Text, Heading } from '@radix-ui/themes';
import { supabase } from '@/lib/supabase';

export default function OnboardingPage() {
    const [isUploading, setIsUploading] = useState(false);
    const [countdown, setCountdown] = useState(0);
    const [error, setError] = useState<string | null>(null);

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
            // TODO: Implement file upload to server
            // For MVP, simulate upload delay and start countdown
            await new Promise(resolve => setTimeout(resolve, 2000));
            setIsUploading(false);
            startCountdown();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred during upload');
            setIsUploading(false);
        }
    };

    const startCountdown = () => {
        setCountdown(5); // 5 minutes countdown
        const interval = setInterval(() => {
            setCountdown(prev => {
                if (prev <= 1) {
                    clearInterval(interval);
                    return 0;
                }
                return prev - 1;
            });
        }, 60000); // Update every minute
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
                    <Box mt="4">
                        <Text size="3">
                            Processing your data... It will be ready in approximately {countdown} minutes.
                        </Text>
                        <Text size="2" color="gray">
                            We'll send you an email when it's done.
                        </Text>
                    </Box>
                )}

                {countdown === 0 && !isUploading && !error && (
                    <Text size="2" color="gray">
                        Upload your LinkedIn data export ZIP file to get started.
                    </Text>
                )}
            </Flex>
        </Box>
    );
}
