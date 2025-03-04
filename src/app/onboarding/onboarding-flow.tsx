// app/onboarding/onboarding-flow.tsx
'use client';

import React, { useState, useEffect, JSX } from 'react';
import { Flex } from '@radix-ui/themes';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import JSZip from 'jszip';
import type {
    ProcessedFile,
    Step,
    UploadStatus
} from './types';
import {
    REQUIRED_FILES,
} from './types';
import {
    StepIndicator,
    ExportStep,
    WaitingStep,
    UploadStep,
    SuccessStep
} from './components';

interface Props {
    initialStep: Step;
    userId: string;
}

function extractSlugFromUrl(url: string): string | null {
    try {
        const path = new URL(url).pathname;
        const segments = path.split("/").filter(Boolean);
        if (segments.length >= 2 && segments[0] === "in") {
            return segments[1];
        }
        return null;
    } catch {
        return null;
    }
}

export default function OnboardingFlow({ initialStep, userId }: Props): JSX.Element {
    const [currentStep, setCurrentStep] = useState<Step>(initialStep);
    const [countdown, setCountdown] = useState<number>(24 * 60 * 60);
    const [selectedFiles, setSelectedFiles] = useState<ProcessedFile[]>([]);
    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [isProcessingUrl, setIsProcessingUrl] = useState(false);
    const [urlError, setUrlError] = useState<string>();

    const supabase = createClient();
    const router = useRouter();

    const handleLinkedInUrl = async (url: string): Promise<void> => {
        setIsProcessingUrl(true);
        setUrlError(undefined);

        try {
            const slug = extractSlugFromUrl(url);
            if (!slug) {
                throw new Error('Invalid LinkedIn URL format');
            }

            // Call the secure database function to claim the profile
            const { error } = await supabase
                .rpc('claim_linkedin_profile', {
                    input_slug: slug
                });

            if (error) {
                if (error.message === 'Profile already claimed') {
                    throw new Error('This LinkedIn profile is already connected to another account');
                }
                throw error;
            }
        } catch (error) {
            console.error('Error processing LinkedIn URL:', error);
            setUrlError(error instanceof Error ? error.message : 'Failed to process LinkedIn URL');
            throw error; // Re-throw to prevent navigation
        } finally {
            setIsProcessingUrl(false);
        }
    };

    useEffect(() => {
        let timer: NodeJS.Timeout;
        if (currentStep === 2 && countdown > 0) {
            timer = setInterval(() => {
                setCountdown(prev => Math.max(0, prev - 1));
            }, 1000);
        }
        return () => clearInterval(timer);
    }, [currentStep, countdown]);

    const formatTime = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    const handleStepChange = async (targetStep?: number): Promise<void> => {
        const nextStep = targetStep ?? (currentStep + 1);
        setCurrentStep(nextStep as Step);

        const { error } = await supabase
            .from('onboarding_state')
            .upsert(
                {
                    user_id: userId,
                    current_step: nextStep,
                    completed_at: nextStep === 4 ? new Date().toISOString() : null,
                    updated_at: new Date().toISOString()
                },
                {
                    onConflict: 'user_id'
                }
            );

        if (error) {
            console.error('Failed to update onboarding state:', error);
        }

        if (nextStep === 4) {
            router.push('/profiles');
        }
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();

        const items = event.dataTransfer.items;
        if (!items) return;

        // Check if a folder is being dropped
        const isFolder = Array.from(items).some(item => {
            const entry = item.webkitGetAsEntry?.();
            return entry?.isDirectory;
        });

        if (isFolder) {
            // If it's a folder, use the folder input
            document.getElementById('folder-upload')?.click();
        } else {
            // If it's files, handle them directly
            const files = event.dataTransfer.files;
            handleFileSelect(files);
        }
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
    };

    const processZipFile = async (file: File): Promise<ProcessedFile[]> => {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);
        const csvFiles: ProcessedFile[] = [];

        for (const [path, zipEntry] of Object.entries(contents.files)) {
            if (!zipEntry.dir) {
                const fileName = path.split('/').pop();
                if (fileName && fileName.endsWith('.csv') && !fileName.startsWith('._')) {
                    const content = await zipEntry.async('blob');
                    csvFiles.push(new File([content], fileName, { type: 'text/csv' }) as ProcessedFile);
                }
            }
        }

        return csvFiles;
    };

    const handleFileSelect = async (files: FileList | null) => {
        if (!files?.length) return;

        setErrorMessage('');
        try {
            const newFiles: ProcessedFile[] = [];

            // Process each file
            for (const file of Array.from(files)) {
                if (file.name.endsWith('.zip')) {
                    const extractedFiles = await processZipFile(file);
                    newFiles.push(...extractedFiles);
                } else if (file.name.endsWith('.csv') && !file.name.startsWith('._')) {
                    newFiles.push(file as ProcessedFile);
                }
            }

            // Add new files to the selection
            const updatedFiles = [...selectedFiles, ...newFiles];
            setSelectedFiles(updatedFiles);

            // Check if we have all required files
            const fileNames = updatedFiles.map(f => f.name);
            const hasRequiredFiles = REQUIRED_FILES.every(required =>
                fileNames.includes(required)
            );

            if (hasRequiredFiles) {
                await uploadFiles(updatedFiles);
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : 'Error processing files');
        }
    };

    const uploadFiles = async (files: ProcessedFile[]): Promise<void> => {
        try {
            setUploadStatus('uploading');

            const { data: profileData, error: profileError } = await supabase
                .from('profiles')
                .select('id')
                .eq('user_id', userId)
                .single();

            if (profileError || !profileData) {
                throw new Error('Could not find user profile');
            }

            // Sort files to ensure Profile.csv and Connections.csv are processed first
            const sortedFiles = [...files].sort((a, b) => {
                if (a.name === 'Profile.csv') return -1;
                if (b.name === 'Profile.csv') return 1;
                if (a.name === 'Connections.csv') return -1;
                if (b.name === 'Connections.csv') return 1;
                return a.name.localeCompare(b.name); // Alphabetical order for remaining files
            });

            // Upload all files in the sorted order
            for (const file of sortedFiles) {
                const filePath = `${profileData.id}/${file.name}`;

                const { error: uploadError } = await supabase.storage
                    .from('linkedin')
                    .upload(filePath, file, {
                        contentType: 'text/csv',
                        upsert: true
                    });

                if (uploadError) throw uploadError;

                const { error: recordError } = await supabase
                    .from('uploads')
                    .insert({
                        profile_id: profileData.id,
                        file_name: file.name,
                        file_path: filePath
                    });

                if (recordError) throw recordError;
            }

            setUploadStatus('success');
            await handleStepChange(4);
        } catch (error) {
            console.error('Upload error:', error);
            setUploadStatus('error');
            setErrorMessage(error instanceof Error ? error.message : 'Failed to upload files');
        }
    };

    return (
        <Flex
            direction="column"
            gap="6"
            p={{ initial: '4', sm: '6' }}
            style={{
                maxWidth: '1200px',
                margin: '0 auto',
                width: '100%'
            }}
        >
            {/* Progress steps */}
            <Flex
                gap={{ initial: '2', sm: '4' }}
                align="center"
                justify="center"
                wrap="wrap"
                style={{
                    background: 'var(--gray-1)',
                    padding: 'var(--space-4)',
                    borderRadius: 'var(--radius-3)',
                    boxShadow: 'var(--shadow-1)'
                }}
            >
                {([1, 2, 3] as const).map((step) => (
                    <StepIndicator
                        key={step}
                        currentStep={currentStep}
                        step={step}
                    />
                ))}
            </Flex>

            {/* Step content */}
            {currentStep === 1 && (
                <ExportStep
                    onNext={handleStepChange}
                    onLinkedInUrl={handleLinkedInUrl}
                    isProcessing={isProcessingUrl}
                    error={urlError}
                />
            )}

            {currentStep === 2 && (
                <WaitingStep
                    countdown={formatTime(countdown)}
                    onNext={() => void handleStepChange(3)}
                />
            )}

            {currentStep === 3 && (
                <UploadStep
                    uploadStatus={uploadStatus}
                    errorMessage={errorMessage}
                    selectedFiles={selectedFiles}
                    onFileSelect={handleFileSelect}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                />
            )}

            {uploadStatus === 'success' && (
                <SuccessStep onComplete={() => void handleStepChange(4)} />
            )}
        </Flex>
    );
}
