// app/onboarding/page.tsx
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import OnboardingFlow from './onboarding-flow';
import { Container, Theme } from '@radix-ui/themes';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
    const supabase = await createClient();

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        redirect('/auth/login');
    }

    // Get existing onboarding state
    const { data: onboardingState } = await supabase
        .from('onboarding_state')
        .select()
        .eq('user_id', user.id)
        .single();

    // If onboarding is completed, redirect to dashboard
    if (onboardingState?.completed_at) {
        redirect('/profiles');
    }

    return (
        <OnboardingFlow
            initialStep={onboardingState?.current_step || 1}
            userId={user.id}
        />
    );
}
