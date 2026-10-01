import Link from 'next/link'
import { notFound } from 'next/navigation'
import PublicShell from '@/components/PublicShell'
import { directory } from '@/components/public-directory/contract'
import { DirectoryNotice, ProfileBody } from '@/components/public-directory/People'
import styles from '@/components/public-directory/Directory.module.css'
export const dynamic = 'force-dynamic'
export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cursor?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]), result = await directory.profile(id, query.cursor)
  if (result.state === 'not-found') notFound()
  return <PublicShell><main className={styles.main}><Link href="/people">← All people</Link>{result.state === 'ready' ? <ProfileBody profile={result.data} /> : <DirectoryNotice kind={result.state} />}</main></PublicShell>
}
