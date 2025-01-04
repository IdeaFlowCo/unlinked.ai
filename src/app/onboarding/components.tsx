// app/onboarding/components.tsx
'use client';

import React, { JSX } from 'react';
import { Card, Text, Button, Flex, Badge, Box } from '@radix-ui/themes';
import { type Step, REQUIRED_FILES, OPTIONAL_FILES } from './types';
import {
  ArrowRightIcon,
  UploadIcon,
  CheckIcon,
  TimerIcon,
  ExternalLinkIcon,
  DownloadIcon
} from '@radix-ui/react-icons';

interface StepIndicatorProps {
  currentStep: Step;
  step: 1 | 2 | 3;
}

export function StepIndicator({ currentStep, step }: StepIndicatorProps): JSX.Element {
  return (
    <Flex align="center" gap="3" className="flex-1">
      <Badge
        size="2"
        variant={currentStep >= step ? 'solid' : 'soft'}
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease'
        }}
      >
        {currentStep > step ? <CheckIcon className="w-4 h-4" /> : step}
      </Badge>
      <Box style={{ flex: 2 }}>
        <Text
          size={{ initial: '1', sm: '2' }}
          weight="bold"
          style={{ whiteSpace: 'nowrap' }}
        >
          {step === 1 ? 'Export Data' : step === 2 ? 'Wait for Download' : 'Upload Files'}
        </Text>
      </Box>
      {step < 3 && (
        <ArrowRightIcon
          style={{
            color: 'var(--gray-8)',
            width: '20px',
            height: '20px'
          }}
        />
      )}
    </Flex>
  );
}

interface ExportStepProps {
  onNext: (step?: number) => void;
  onLinkedInUrl: (url: string) => Promise<void>;
  isProcessing?: boolean;
  error?: string;
}

// Common card styling
const cardStyles = {
  width: '100%',
  maxWidth: '600px',
  margin: '0 auto',
  transition: 'transform 0.2s ease',
  ':hover': {
    transform: 'translateY(-2px)'
  }
};

export function ExportStep({ onNext, onLinkedInUrl, isProcessing, error }: ExportStepProps): JSX.Element {
  const [url, setUrl] = React.useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (url) {
      await onLinkedInUrl(url);
    }
  };

  const handleSkip = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!url) {
      setUrl('');  // Clear any partial input
      return;
    }
    await onLinkedInUrl(url);
    onNext(3);
  };

  return (
    <Card size="3" style={cardStyles}>
      <Flex direction="column" gap="4" align="center" p={{ initial: '4', sm: '6' }}>
        <Box style={{
          background: 'var(--accent-2)',
          padding: '16px',
          borderRadius: '50%',
        }}>
          <DownloadIcon
            width="32"
            height="32"
            style={{ color: 'var(--accent-9)' }}
          />
        </Box>
        <Text size={{ initial: '5', sm: '6' }} weight="bold" align="center">
          Hey! What&apos;s your LinkedIn URL?
        </Text>
        <Text size="2" align="center" color="gray" style={{ maxWidth: '400px' }}>
          Just paste your profile link below and we&apos;ll get started 😊
        </Text>
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '320px' }}>
          <Flex direction="column" gap="3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Your LinkedIn Profile URL"
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 'var(--radius-2)',
                border: '1px solid var(--gray-6)',
                fontSize: 'var(--font-size-2)'
              }}
              required
            />
            {error && (
              <Text color="red" size="2">
                {error}
              </Text>
            )}
            <Button
              size="3"
              type="submit"
              disabled={isProcessing || !url}
              style={{
                width: '100%',
                background: 'var(--accent-9)',
                transition: 'all 0.2s ease'
              }}
            >
              {isProcessing ? (
                <Flex gap="2" align="center">
                  <span className="loading-spinner" />
                  Processing...
                </Flex>
              ) : (
                <>
                  <ExternalLinkIcon width="16" height="16" />
                  Continue to Export
                </>
              )}
            </Button>
            <Button
              size="2"
              variant="soft"
              onClick={handleSkip}
              disabled={isProcessing || !url}
              style={{ width: '100%' }}
            >
              Skip to Upload
            </Button>
          </Flex>
        </form>
      </Flex>
    </Card>
  );
}

interface WaitingStepProps {
  countdown: string;
  onNext: (step?: number) => void;
}

export function WaitingStep({ countdown, onNext }: WaitingStepProps): JSX.Element {
  return (
    <Card size="3" className="w-full max-w-xl mx-auto">
      <Flex direction="column" gap="4" align="center" p="6">
        <TimerIcon className="w-12 h-12" style={{ color: 'var(--accent-9)' }} />
        <Text size="6" weight="bold" align="center">
          Waiting for LinkedIn Export
        </Text>
        <Text size="8" weight="bold" style={{ color: 'var(--accent-9)' }}>
          {countdown}
        </Text>
        <Text size="2" align="center" color="gray">
          LinkedIn is preparing your data. You&apos;ll receive an email when it&apos;s ready.
        </Text>
        <Flex direction="column" gap="3" style={{ width: '100%', maxWidth: '280px' }}>
          <Button size="3" onClick={() => onNext()} style={{ width: '100%' }}>
            I Have My Data
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

interface UploadStepProps {
  uploadStatus: 'idle' | 'uploading' | 'success' | 'error';
  errorMessage: string;
  selectedFiles: File[];
  onFileSelect: (files: FileList | null) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
}

export function UploadStep({
  uploadStatus,
  errorMessage,
  selectedFiles,
  onFileSelect,
  onDrop,
  onDragOver
}: UploadStepProps): JSX.Element {
  return (
    <Card size="3" style={cardStyles}>
      <Flex
        direction="column"
        gap="4"
        align="center"
        p={{ initial: '4', sm: '6' }}
        style={{
          border: '2px dashed var(--accent-6)',
          borderRadius: 'var(--radius-4)',
          background: 'var(--gray-1)',
          transition: 'all 0.2s ease-in-out',
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <Box style={{
          background: 'var(--accent-2)',
          padding: '16px',
          borderRadius: '50%',
          marginBottom: '8px'
        }}>
          <UploadIcon
            width="32"
            height="32"
            style={{ color: 'var(--accent-9)' }}
          />
        </Box>

        <Text size={{ initial: '5', sm: '6' }} weight="bold" align="center">
          Upload Your LinkedIn Data
        </Text>

        <Text size="2" align="center" color="gray" style={{ maxWidth: '400px' }}>
          Drag and drop your LinkedIn data export or select files manually
        </Text>

        <input
          type="file"
          accept=".csv,.zip"
          multiple
          onChange={(e) => onFileSelect(e.target.files)}
          style={{ display: 'none' }}
          id="file-upload"
        />

        <Flex
          direction="column"
          gap="3"
          style={{ width: '100%', maxWidth: '320px' }}
        >
          <Button
            size="3"
            onClick={() => document.getElementById('file-upload')?.click()}
            disabled={uploadStatus === 'uploading'}
            style={{
              width: '100%',
              background: uploadStatus === 'uploading' ? 'var(--accent-8)' : 'var(--accent-9)',
              transition: 'all 0.2s ease'
            }}
          >
            {uploadStatus === 'uploading' ? (
              <Flex gap="2" align="center">
                <span className="loading-spinner" />
                Uploading...
              </Flex>
            ) : (
              <>
                <UploadIcon width="16" height="16" />
                Select Files
              </>
            )}
          </Button>
        </Flex>

        {errorMessage && (
          <Text color="red" size="2" style={{ marginTop: 'var(--space-2)' }}>
            {errorMessage}
          </Text>
        )}

        {selectedFiles.length > 0 && (
          <Flex direction="column" gap="2" style={{ width: '100%', maxWidth: '280px' }}>
            <Text size="2" weight="bold">Selected files:</Text>
            {selectedFiles
              .filter(file => REQUIRED_FILES.includes(file.name as typeof REQUIRED_FILES[number]) ||
                OPTIONAL_FILES.includes(file.name as typeof OPTIONAL_FILES[number]))
              .map((file, index) => (
                <Text key={index} size="2" color="gray">
                  {file.name}
                </Text>
              ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

interface SuccessStepProps {
  onComplete: () => void;
}

export function SuccessStep({ onComplete }: SuccessStepProps): JSX.Element {
  return (
    <Card size="3" className="w-full max-w-xl mx-auto">
      <Flex direction="column" gap="4" align="center" p="6">
        <CheckIcon className="w-12 h-12" style={{ color: 'var(--accent-9)' }} />
        <Text size="6" weight="bold" align="center">
          Upload Complete!
        </Text>
        <Text size="2" align="center" color="gray">
          Your LinkedIn data has been successfully uploaded.
        </Text>
        <Button size="3" onClick={onComplete} style={{ width: '100%', maxWidth: '280px' }}>
          Continue to Profiles
        </Button>
      </Flex>
    </Card>
  );
}
