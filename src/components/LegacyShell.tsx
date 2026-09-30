import { Box } from '@radix-ui/themes'
import type { ReactNode } from 'react'
import Header from '@/components/header'

export default function LegacyShell({ children }: { children: ReactNode }) {
  return <Box style={{ minHeight: '100vh', background: 'linear-gradient(to bottom, var(--gray-1), white)' }}><Header />{children}</Box>
}
