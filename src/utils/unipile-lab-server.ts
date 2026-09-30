import { createClient } from '@/utils/supabase/server'
import { configuredProvider } from './unipile-provider'
import { isAllowedTester, LabError, UnipileLab } from './unipile-lab'

let singleton: UnipileLab | undefined
export function labEnabled() { return process.env.UNLINKED_UNIPILE_TEST_ENABLED === 'true' }
export function labMode() { return process.env.UNLINKED_UNIPILE_TEST_MODE === 'live' ? 'live' : 'fixture' }

export async function testerId(): Promise<string | null> {
  if (!labEnabled()) return null
  const allowlist = process.env.UNLINKED_UNIPILE_TEST_USER_IDS ?? ''
  if (!allowlist || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user || !isAllowedTester(labEnabled(), allowlist, user.id)) return null
  return user.id
}

export function lab(): UnipileLab {
  if (!labEnabled()) throw new LabError('denied', 'Private lab is disabled.')
  if (!singleton) {
    const { provider, demoAccountId } = configuredProvider()
    const allowedTargets = labMode() === 'live'
      ? (process.env.UNLINKED_UNIPILE_ALLOWED_TARGET_SLUGS ?? '').split(',').map(value => value.trim()).filter(Boolean)
      : undefined
    singleton = new UnipileLab(provider, demoAccountId, undefined, allowedTargets)
  }
  return singleton
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (!origin || !host) return false
  try {
    const parsed = new URL(origin)
    return parsed.host === host && parsed.protocol === new URL(request.url).protocol
  } catch { return false }
}

export function callbackOrigin(request: Request): string {
  if (process.env.UNLINKED_UNIPILE_TEST_MODE !== 'live') return new URL(request.url).origin
  const configured = process.env.UNLINKED_UNIPILE_TEST_ORIGIN
  if (!configured) throw new LabError('unavailable', 'Live callback origin is not configured.')
  let url: URL
  try { url = new URL(configured) } catch { throw new LabError('unavailable', 'Live callback origin is invalid.') }
  if (url.protocol !== 'https:' || url.origin !== configured || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new LabError('unavailable', 'Live callback origin is invalid.')
  }
  if (new URL(request.url).origin !== url.origin) throw new LabError('denied', 'Request host did not match live stage.')
  return url.origin
}
