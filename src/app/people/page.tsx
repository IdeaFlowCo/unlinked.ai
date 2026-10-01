import Link from 'next/link'
import PublicShell from '@/components/PublicShell'
import { directory } from '@/components/public-directory/contract'
import { DirectoryNotice, PeopleList } from '@/components/public-directory/People'
import styles from '@/components/public-directory/Directory.module.css'

export const dynamic = 'force-dynamic'
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
  const params = await searchParams, query = typeof params.q === 'string' ? params.q.slice(0, 200) : '', cursor = typeof params.cursor === 'string' ? params.cursor : undefined
  const result = await directory.list(query, cursor)
  return <PublicShell><main className={styles.main}><p className={styles.eyebrow}>People on Unlinked</p><h1>A person.<br />A possibility.</h1><p className={styles.lead}>Find public profiles by name or headline. Your own imported network stays in the beta app.</p>
    <form className={styles.search} action="/people"><label htmlFor="people-query">Search people<input id="people-query" name="q" type="search" defaultValue={query} maxLength={200} placeholder="Name or headline" /></label><button className={styles.button} type="submit">Search</button>{query && <Link href="/people">Clear search</Link>}</form>
    {result.state === 'ready' ? <>{result.data.profiles.length ? <PeopleList people={result.data.profiles} /> : <DirectoryNotice kind="empty" />}{result.data.nextCursor && <div className={styles.pager}><Link className={styles.button} href={`/people?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(result.data.nextCursor)}`}>More people →</Link></div>}</> : <DirectoryNotice kind="unavailable" />}
  </main></PublicShell>
}
