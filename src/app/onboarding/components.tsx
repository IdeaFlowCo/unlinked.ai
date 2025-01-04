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

// Common card styling
const cardStyles = {
  width: '100%',
  maxWidth: '480px',  // Slightly smaller for better readability
  margin: '0 auto',
  transition: 'all 0.2s ease',
  background: 'var(--color-background)',
  border: '1px solid var(--gray-4)',
  ':hover': {
    transform: 'translateY(-2px)',
    boxShadow: 'var(--shadow-3)'
  }
};

// Common icon container styling
const iconContainerStyles = {
  background: 'var(--accent-2)',
  padding: '20px',
  borderRadius: '50%',
  marginBottom: '8px',
  transition: 'all 0.2s ease',
  border: '1px solid var(--accent-3)',
  ':hover': {
    transform: 'scale(1.05)',
    background: 'var(--accent-3)'
  }
};

// Common input styling
const inputStyles = {
  width: '100%',
  padding: '12px 16px',
  borderRadius: 'var(--radius-3)',
  border: '1px solid var(--gray-5)',
  fontSize: 'var(--font-size-2)',
  transition: 'all 0.2s ease',
  background: 'var(--color-background)',
  ':focus': {
    outline: 'none',
    borderColor: 'var(--accent-8)',
    boxShadow: '0 0 0 2px var(--accent-a4)'
  },
  ':hover': {
    borderColor: 'var(--gray-8)'
  }
};

export function StepIndicator({ currentStep, step }: StepIndicatorProps): JSX.Element {
  return (
    <Flex align="center" gap="3" className="flex-1">
      <Badge
        size="2"
        variant={currentStep >= step ? 'solid' : 'soft'}
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease',
          border: currentStep >= step ? 'none' : '1px solid var(--gray-5)'
        }}
      >
        {currentStep > step ? <CheckIcon className="w-5 h-5" /> : step}
      </Badge>
      <Box style={{ flex: 2 }}>
        <Text
          size={{ initial: '2', sm: '3' }}
          weight="medium"
          style={{ whiteSpace: 'nowrap' }}
        >
          {step === 1 ? 'connect' : step === 2 ? 'wait' : 'upload'}
        </Text>
      </Box>
      {step < 3 && (
        <ArrowRightIcon
          style={{
            color: 'var(--gray-8)',
            width: '24px',
            height: '24px'
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

export function ExportStep({ onNext, onLinkedInUrl, isProcessing, error }: ExportStepProps): JSX.Element {
  const [url, setUrl] = React.useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (url) {
      await onLinkedInUrl(url);
      onNext(2);  // Go to export step
    }
  };

  const handleSkip = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!url) {
      setUrl('');  // Clear any partial input
      return;
    }
    await onLinkedInUrl(url);
    onNext(3);  // Skip to upload step
  };

  return (
    <Card size="3" style={cardStyles}>
      <Flex direction="column" gap="5" align="center" p={{ initial: '5', sm: '7' }}>
        <Box style={iconContainerStyles}>
          <DownloadIcon
            width="32"
            height="32"
            style={{ color: 'var(--accent-9)' }}
          />
        </Box>
        <Flex direction="column" gap="3" style={{ textAlign: 'center' }}>
          <Text size={{ initial: '6', sm: '7' }} weight="bold">
            hey! what&apos;s your linkedin url?
          </Text>
          <Text size="2" color="gray" style={{ maxWidth: '320px', lineHeight: '1.5' }}>
            paste your profile link below and we&apos;ll get started 😊
          </Text>
        </Flex>
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '320px' }}>
          <Flex direction="column" gap="3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="your linkedin profile url"
              style={inputStyles}
              required
            />
            {error && (
              <Text color="red" size="2" style={{ marginTop: '-4px' }}>
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
                transition: 'all 0.2s ease',
                height: '44px'
              }}
            >
              {isProcessing ? (
                <Flex gap="2" align="center" justify="center">
                  <span className="loading-spinner" />
                  processing...
                </Flex>
              ) : (
                <>
                  <ExternalLinkIcon width="18" height="18" />
                  export your data
                </>
              )}
            </Button>
            <Button
              size="3"
              variant="soft"
              onClick={handleSkip}
              disabled={isProcessing || !url}
              style={{ width: '100%', height: '44px' }}
            >
              skip to upload
            </Button>
          </Flex>
        </form>
      </Flex>
    </Card>
  );
}

export function WaitingStep({ countdown, onNext }: { countdown: string; onNext: () => void }): JSX.Element {
  return (
    <Card size="3" style={cardStyles}>
      <Flex direction="column" gap="5" align="center" p={{ initial: '5', sm: '7' }}>
        <Box style={iconContainerStyles}>
          <TimerIcon width="32" height="32" style={{ color: 'var(--accent-9)' }} />
        </Box>
        <Flex direction="column" gap="3" style={{ textAlign: 'center' }}>
          <Text size={{ initial: '6', sm: '7' }} weight="bold">
            waiting for your data
          </Text>
          <Text size="8" weight="bold" style={{ color: 'var(--accent-9)', letterSpacing: '0.05em' }}>
            {countdown}
          </Text>
          <Text size="2" color="gray" style={{ maxWidth: '320px', lineHeight: '1.5' }}>
            linkedin is preparing your data. you&apos;ll get an email when it&apos;s ready 📧
          </Text>
        </Flex>
        <Button size="3" onClick={onNext} style={{ width: '100%', maxWidth: '280px', height: '44px' }}>
          i have my data
        </Button>
      </Flex>
    </Card>
  );
}

export function UploadStep({
  uploadStatus,
  errorMessage,
  selectedFiles,
  onFileSelect,
  onDrop,
  onDragOver
}: {
  uploadStatus: 'idle' | 'uploading' | 'success' | 'error';
  errorMessage: string;
  selectedFiles: File[];
  onFileSelect: (files: FileList | null) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <Card size="3" style={cardStyles}>
      <Flex
        direction="column"
        gap="5"
        align="center"
        p={{ initial: '5', sm: '7' }}
        style={{
          border: '2px dashed var(--accent-6)',
          borderRadius: 'var(--radius-4)',
          background: 'var(--accent-1)',
          transition: 'all 0.2s ease-in-out',
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <Box style={iconContainerStyles}>
          <UploadIcon
            width="32"
            height="32"
            style={{ color: 'var(--accent-9)' }}
          />
        </Box>

        <Flex direction="column" gap="3" style={{ textAlign: 'center' }}>
          <Text size={{ initial: '6', sm: '7' }} weight="bold">
            upload your linkedin data
          </Text>
          <Text size="2" color="gray" style={{ maxWidth: '320px', lineHeight: '1.5' }}>
            drag and drop your files here, or click to browse 📂
          </Text>
        </Flex>

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
              transition: 'all 0.2s ease',
              height: '44px'
            }}
          >
            {uploadStatus === 'uploading' ? (
              <Flex gap="2" align="center" justify="center">
                <span className="loading-spinner" />
                uploading...
              </Flex>
            ) : (
              <>
                <UploadIcon width="18" height="18" />
                select files
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
          <Flex direction="column" gap="3" style={{ width: '100%', maxWidth: '320px' }}>
            <Text size="2" weight="medium">selected files:</Text>
            {selectedFiles
              .filter(file => REQUIRED_FILES.includes(file.name as typeof REQUIRED_FILES[number]) ||
                OPTIONAL_FILES.includes(file.name as typeof OPTIONAL_FILES[number]))
              .map((file, index) => (
                <Text key={index} size="2" color="gray" style={{ fontFamily: 'var(--font-mono)' }}>
                  {file.name}
                </Text>
              ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

export function SuccessStep({ onComplete }: { onComplete: () => void }): JSX.Element {
  return (
    <Card size="3" style={cardStyles}>
      <Flex direction="column" gap="5" align="center" p={{ initial: '5', sm: '7' }}>
        <Box style={iconContainerStyles}>
          <CheckIcon width="32" height="32" style={{ color: 'var(--accent-9)' }} />
        </Box>
        <Flex direction="column" gap="3" style={{ textAlign: 'center' }}>
          <Text size={{ initial: '6', sm: '7' }} weight="bold">
            all done! 🎉
          </Text>
          <Text size="2" color="gray" style={{ maxWidth: '320px', lineHeight: '1.5' }}>
            your linkedin data has been uploaded successfully
          </Text>
        </Flex>
        <Button size="3" onClick={onComplete} style={{ width: '100%', maxWidth: '280px', height: '44px' }}>
          continue to profiles
        </Button>
      </Flex>
    </Card>
  );
}
