import { notFound } from 'next/navigation'
import { testerId } from '@/utils/unipile-lab-server'
import LabPanel from './panel'

export const dynamic = 'force-dynamic'
export default async function UnipileLabPage() {
  if (!await testerId()) notFound()
  return <LabPanel />
}
