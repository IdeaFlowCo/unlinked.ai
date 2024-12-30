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
    OPTIONAL_FILES,
    LINKEDIN_EXPORT_URL
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

export default function OnboardingFlow({ initialStep, userId }: Props): JSX.Element {
    const [currentStep, setCurrentStep] = useState<Step>(initialStep);
    const [countdown, setCountdown] = useState<number>(24 * 60 * 60);
    const [selectedFiles, setSelectedFiles] = useState<ProcessedFile[]>([]);
    const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string>('');

    const supabase = createClient();
    const router = useRouter();

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

    const handleStepChange = async (newStep: Step): Promise<void> => {
        setCurrentStep(newStep);

        if (newStep === 2) {
            window.open(LINKEDIN_EXPORT_URL, '_blank', 'noopener,noreferrer');
        }

        const { error } = await supabase
            .from('onboarding_state')
            .upsert(
                {
                    user_id: userId,
                    current_step: newStep,
                    completed_at: newStep === 4 ? new Date().toISOString() : null,
                    updated_at: new Date().toISOString()
                },
                {
                    onConflict: 'user_id'
                }
            );

        if (error) {
            console.error('Failed to update onboarding state:', error);
        }

        if (newStep === 4) {
            router.push('/profiles');
        }
    };

    const processZipFile = async (file: File): Promise<ProcessedFile[]> => {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);
        const csvFiles: ProcessedFile[] = [];

        for (const [path, zipEntry] of Object.entries(contents.files)) {
            if (!zipEntry.dir) {
                const fileName = path.split('/').pop();
                if (fileName && ([...REQUIRED_FILES, ...OPTIONAL_FILES] as readonly string[]).includes(fileName)) {
                    const content = await zipEntry.async('blob');
                    csvFiles.push(new File([content], fileName, { type: 'text/csv' }) as ProcessedFile);
                }
            }
        }

        return csvFiles;
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        event.stopPropagation();
    };

    const handleDrop = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
        event.preventDefault();
        event.stopPropagation();
        await handleFileSelect(event.dataTransfer.files);
    };

    const handleFileSelect = async (fileList: FileList | null): Promise<void> => {
        if (!fileList?.length) return;

        setErrorMessage('');
        const processedFiles: ProcessedFile[] = [];

        try {
            for (const file of Array.from(fileList)) {
                if (file.name.endsWith('.zip')) {
                    const extractedFiles = await processZipFile(file);
                    processedFiles.push(...extractedFiles);
                } else if (file.name.endsWith('.csv')) {
                    processedFiles.push(file as ProcessedFile);
                }
            }

            const fileNames = processedFiles.map(f => f.name);
            const hasRequiredFiles = REQUIRED_FILES.every(required =>
                fileNames.includes(required)
            );

            if (!hasRequiredFiles) {
                throw new Error(`Missing required files. Please ensure you have ${REQUIRED_FILES.join(' and ')}`);
            }

            setSelectedFiles(processedFiles);
            await uploadFiles(processedFiles);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : 'Error processing files');
        }
    };

    const uploadFiles = async (files: ProcessedFile[]): Promise<void> => {
        try {
            setUploadStatus('uploading');

            // Sort files to ensure correct order: Profile.csv first, then Connections.csv, then others
            const sortedFiles = [...files].sort((a, b) => {
                if (a.name === 'Profile.csv') return -1;
                if (b.name === 'Profile.csv') return 1;
                if (a.name === 'Connections.csv') return -1;
                if (b.name === 'Connections.csv') return 1;
                return 0;
            });

            // Upload files to storage and create upload records in sequence
            for (const file of sortedFiles) {
                const filePath = `${userId}/${file.name}`;

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
                        file_name: file.name,
                        file_path: filePath,
                        user_id: userId
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
        <Flex direction="column" gap="6" className="py-8">
            {/* Progress steps */}
            <Flex gap="4" align="center" justify="center">
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
                <ExportStep onNext={() => void handleStepChange(2)} />
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
