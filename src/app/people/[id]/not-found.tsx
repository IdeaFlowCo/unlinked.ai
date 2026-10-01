import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import { DirectoryNotice } from '@/components/public-directory/People'
import styles from '@/components/public-directory/Directory.module.css'
export default function MissingPublicProfile() {
  return <PublicShell><main className={styles.main}><Link href="/people">← All people</Link><DirectoryNotice kind="not-found" /></main></PublicShell>
}
