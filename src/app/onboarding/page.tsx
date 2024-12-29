import LinkedInUpload from './LinkedInUpload';
import { Text } from '@radix-ui/themes';

export default function OnboardingPage() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
      <Text size="6" mb="4" weight="bold">Upload LinkedIn Data</Text>
      <LinkedInUpload />
    </div>
  );
}
