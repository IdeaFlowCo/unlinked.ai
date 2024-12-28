// app/providers.tsx
'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PropsWithChildren, useState } from 'react'
import { Theme } from '@radix-ui/themes'

export default function Providers({ children }: PropsWithChildren) {
    const [queryClient] = useState(() => new QueryClient())

    return (
        <QueryClientProvider client={queryClient}>
            <Theme accentColor="violet" grayColor="mauve" radius="small" scaling="110%">
                {children}
            </Theme>
        </QueryClientProvider>
    )
}
