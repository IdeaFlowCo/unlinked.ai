'use client'

import { useRouter } from 'next/navigation'
import { LINKEDIN_EXPORT_URL } from '@/app/onboarding/types'

export default function StartLinkedInExport() {
  const router = useRouter()
  return <a className="public-button public-button-primary" href={LINKEDIN_EXPORT_URL} target="_blank" rel="noopener noreferrer" onClick={() => router.push('/import-linkedin')}>Start my LinkedIn export ↗</a>
}
