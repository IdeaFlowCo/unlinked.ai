// app/layout.tsx
import '@radix-ui/themes/styles.css'
import './globals.css'
import { Box } from '@radix-ui/themes'
import type { Metadata } from 'next'
import Providers from './providers'

export const metadata: Metadata = {
  title: 'unlinked.ai',
  description: 'Your private LinkedIn network, profile and AI search. Meet new people with an OpenChat card.',
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
          <Box style={{ minHeight: '100vh' }}>{children}</Box>
        </Providers>
      </body>
    </html>
  )
}
