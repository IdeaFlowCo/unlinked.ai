// app/layout.tsx
import '@radix-ui/themes/styles.css'
import { Box } from '@radix-ui/themes'
import type { Metadata } from 'next'
import Providers from './providers'
import Header from '@/components/header'

export const metadata: Metadata = {
  title: 'unlinked.ai',
  description: 'AI-powered LinkedIn tool',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Box style={{
            minHeight: '100vh',
            background: 'linear-gradient(to bottom, var(--gray-1), white)'
          }}>
            <Header />
            {children}
          </Box>
        </Providers>
      </body>
    </html>
  )
}
