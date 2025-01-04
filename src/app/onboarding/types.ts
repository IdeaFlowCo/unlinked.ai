// app/onboarding/types.ts
export type Step = 1 | 2 | 3 | 4;
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export interface ExportStepProps {
    onNext: (step?: number) => void;
    onLinkedInUrl: (url: string) => Promise<void>;
    isProcessing?: boolean;
    error?: string;
}

export const LINKEDIN_EXPORT_URL = 'https://www.linkedin.com/psettings/member-data' as const;
export const REQUIRED_FILES = ['Connections.csv'] as const;
export const OPTIONAL_FILES = ['Profile.csv', 'Positions.csv', 'Education.csv', 'Skills.csv'] as const;

export interface ProcessedFile extends File {
    readonly name: string;
}

export interface OnboardingState {
    id: string;
    user_id: string;
    current_step: Step;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
}
