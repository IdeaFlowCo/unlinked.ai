import '@radix-ui/themes/styles.css';
import { Theme, Box } from '@radix-ui/themes';
import type { Metadata } from 'next';
import Header from '@/components/header';

export const metadata: Metadata = {
  title: 'AI LinkedIn',
  description: 'AI-powered LinkedIn tool',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Theme accentColor="violet" grayColor="mauve" radius="small" scaling="110%">
          <Box>
            <Header />
            {children}
          </Box>
        </Theme>
      </body>
    </html>
  );
}
