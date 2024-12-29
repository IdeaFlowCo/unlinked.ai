// app/onboarding/types.ts
export type Step = 1 | 2 | 3 | 4;
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export const LINKEDIN_EXPORT_URL = 'https://www.linkedin.com/psettings/member-data' as const;
export const REQUIRED_FILES = ['Profile.csv', 'Connections.csv'] as const;
export const OPTIONAL_FILES = ['Positions.csv', 'Education.csv', 'Skills.csv'] as const;

export interface ProcessedFile extends File {
    readonly name: typeof REQUIRED_FILES[number] | typeof OPTIONAL_FILES[number];
}

export interface OnboardingState {
    id: string;
    user_id: string;
    current_step: Step;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
}
