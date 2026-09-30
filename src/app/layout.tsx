// app/layout.tsx
import '@radix-ui/themes/styles.css'
import { Box } from '@radix-ui/themes'
import type { Metadata } from 'next'
import Providers from './providers'

export const metadata: Metadata = {
  title: 'unlinked.ai',
  description: 'Meet in person. Stay in touch. Scan an OpenChat card to connect.',
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
