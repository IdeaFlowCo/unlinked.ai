// app/onboarding/components.tsx
'use client';

import React, { JSX } from 'react';
import { Card, Text, Button, Flex, Badge, Box } from '@radix-ui/themes';
import type { Step } from './types';
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
        className="w-8 h-8 rounded-full flex items-center justify-center"
      >
        {currentStep > step ? <CheckIcon className="w-4 h-4" /> : step}
      </Badge>
      <Box className="flex-1">
        <Text size="2" weight="bold">
          Step {step}
        </Text>
        <Text size="1" color="gray">
          {step === 1 ? 'Export Data' : step === 2 ? 'Wait for Download' : 'Upload Files'}
        </Text>
      </Box>
      {step < 3 && <ArrowRightIcon className="text-gray-400 w-5 h-5" />}
    </Flex>
  );
}

interface ExportStepProps {
  onNext: () => void;
}

export function ExportStep({ onNext }: ExportStepProps): JSX.Element {
  return (
    <Card size="3" className="w-full max-w-xl mx-auto">
      <Flex direction="column" gap="4" align="center" p="6">
        <DownloadIcon className="w-10 h-10 text-blue-500" />
        <Text size="6" weight="bold" align="center">
          Export Your LinkedIn Data
        </Text>
        <Text size="2" align="center" color="gray">
          First, you&apos;ll need to request your data from LinkedIn. This process typically takes 24 hours.
        </Text>
        <Button
          size="3"
          onClick={onNext}
        >
          <ExternalLinkIcon width="16" height="16" />
          Start LinkedIn Export
        </Button>
      </Flex>
    </Card>
  );
}

interface WaitingStepProps {
  countdown: string;
  onNext: () => void;
}

export function WaitingStep({ countdown, onNext }: WaitingStepProps): JSX.Element {
  return (
    <Card size="3" className="w-full max-w-xl mx-auto">
      <Flex direction="column" gap="4" align="center" p="6">
        <TimerIcon className="w-10 h-10 text-blue-500" />
        <Text size="6" weight="bold" align="center">
          Waiting for LinkedIn Export
        </Text>
        <Text size="8" weight="bold" color="blue">
          {countdown}
        </Text>
        <Text size="2" align="center" color="gray">
          LinkedIn is preparing your data. You&apos;ll receive an email when it&apos;s ready.
        </Text>
        <Button size="3" variant="soft" onClick={onNext}>
          I Have My Data
        </Button>
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
    <Card size="3" className="w-full max-w-xl mx-auto">
      <Flex
        direction="column"
        gap="4"
        align="center"
        p="6"
        className="border-2 border-dashed border-gray-200 rounded-lg"
        style={{ background: 'var(--gray-1)' }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <UploadIcon className="w-10 h-10 text-blue-500" />
        <Text size="6" weight="bold" align="center">
          Upload Your LinkedIn Data
        </Text>
        <Text size="2" align="center" color="gray">
          Drag and drop your LinkedIn data export ZIP file or CSV files here
        </Text>

        <input
          type="file"
          accept=".csv,.zip"
          multiple
          onChange={(e) => onFileSelect(e.target.files)}
          style={{ display: 'none' }}
          id="file-upload"
        />

        <Button
          size="3"
          onClick={() => document.getElementById('file-upload')?.click()}
          disabled={uploadStatus === 'uploading'}
        >
          {uploadStatus === 'uploading' ? 'Uploading...' : 'Select Files'}
        </Button>

        {errorMessage && (
          <Text color="red" size="2">
            {errorMessage}
          </Text>
        )}

        {selectedFiles.length > 0 && (
          <Flex direction="column" gap="2" className="w-full">
            <Text size="2" weight="bold">Selected files:</Text>
            {selectedFiles.map((file, index) => (
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
        <CheckIcon className="w-10 h-10 text-green-500" />
        <Text size="6" weight="bold" align="center">
          Upload Complete!
        </Text>
        <Text size="2" align="center" color="gray">
          Your LinkedIn data has been successfully uploaded.
        </Text>
        <Button size="3" onClick={onComplete}>
          Continue to Dashboard
        </Button>
      </Flex>
    </Card>
  );
}
