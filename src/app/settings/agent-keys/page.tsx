// app/settings/agent-keys/page.tsx
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import AgentKeysManager from './AgentKeysManager'

export const dynamic = 'force-dynamic'

export default async function AgentKeysPage() {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    redirect('/auth/login')
  }

  return <AgentKeysManager />
}
