'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import LinkedInUpload from './LinkedInUpload';
import { Text } from '@radix-ui/themes';
import { createClient } from '@/utils/supabase/client';

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) {
        router.push('/auth/login');
      }
    };
    
    checkAuth();
  }, [router, supabase.auth]);

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <Text size="6" mb="4" weight="bold">Upload LinkedIn Data</Text>
      <LinkedInUpload />
    </div>
  );
}
