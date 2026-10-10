import { publicLinkedinUrl, publicWebsite } from '../../utils/public-people/profile-links.mjs'
import Link from 'next/link'
import type { PublicPerson, PublicProfile } from './contract'
import styles from './Directory.module.css'
import { unlinkedProfileContext, unlinkedMessagesUrl } from '../../utils/openchat-profile-context.mjs'

export function PeopleList({ people }: { people: PublicPerson[] }) {
  return <ul className={styles.people}>{people.map(person => <li key={person.id}><Link href={`/people/${encodeURIComponent(person.id)}`}><span className={styles.avatar} aria-hidden="true">{person.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span><div><h3>{person.name}</h3>{person.headline && <p>{person.headline}</p>}{person.location && <small>{person.location}</small>}</div><span aria-hidden="true">→</span></Link></li>)}</ul>
}
export function DirectoryNotice({ kind }: { kind: 'unavailable' | 'empty' | 'not-found' }) {
  const copy = { unavailable: ['The public directory is not connected yet.', 'Public profile data is still being connected. This is different from an empty directory. Your own imported network remains available in the beta app.'], empty: ['No profiles match this search.', 'Try a different name or title, or clear your search to browse everyone.'], 'not-found': ['This public profile could not be found.', 'The profile may no longer be published. Return to the directory to find another person.'] }[kind]
  return <section className={styles.notice} role="status"><h2>{copy[0]}</h2><p>{copy[1]}</p><a href="https://www.unlinked.ai/login">Open my own network →</a></section>
}
export function ProfileBody({ profile }: { profile: PublicProfile }) {
  const linkedin = publicLinkedinUrl(profile.linkedinUrl), website = publicWebsite(profile.website)
  const date = (start?: string, end?: string) => [start, end].filter(Boolean).join(' – ')
  return <div className={styles.profileGrid}><div>
    <section className={styles.profileHeader}><span className={styles.avatar} aria-hidden="true">{profile.name[0]}</span><p className={styles.eyebrow}>Public profile</p><h1>{profile.name}</h1>{profile.headline && <p className={styles.lead}>{profile.headline}</p>}{profile.location && <p>{profile.location}</p>}{profile.industry && <p>{profile.industry}</p>}{profile.company && <p><Link href={`/companies/${encodeURIComponent(profile.company)}`}>{profile.company}</Link></p>}{(linkedin || website) && <p>{linkedin && <a href={linkedin} target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a>}{linkedin && website && ' · '}{website && <a href={website} target="_blank" rel="noopener noreferrer nofollow">Website ↗</a>}</p>}<a className={styles.button} href={unlinkedMessagesUrl(unlinkedProfileContext(profile.id))}>Message</a><p>Message this person using your shared Ideaflow account.</p></section>
    {profile.about && <section className={styles.section}><h2>About</h2><p>{profile.about}</p></section>}
    <section className={styles.section}><h2>Experience</h2>{profile.positions.length ? profile.positions.map((position, index) => <article key={index}><h3>{position.title}</h3><p>{position.company}</p>{date(position.startDate, position.endDate) && <small>{date(position.startDate, position.endDate)}</small>}{position.description && <p>{position.description}</p>}</article>) : <p>No experience has been shared on this profile.</p>}</section>
    <section className={styles.section}><h2>Education</h2>{profile.education.length ? profile.education.map((education, index) => <article key={index}><h3>{education.institution}</h3>{education.degree && <p>{education.degree}</p>}{date(education.startDate, education.endDate) && <small>{date(education.startDate, education.endDate)}</small>}</article>) : <p>No education has been shared on this profile.</p>}</section>
    {profile.skills.length > 0 && <section className={styles.section}><h2>Skills</h2><ul className={styles.skills}>{profile.skills.map((skill, index) => <li key={index}>{skill}</li>)}</ul></section>}
  </div><aside className={styles.section}><h2>Connections</h2><p>People shared on this public profile.</p>{profile.connections.length ? <PeopleList people={profile.connections} /> : <p>No public connections have been shared.</p>}{profile.nextConnectionsCursor && <Link className={styles.button} href={`/people/${encodeURIComponent(profile.id)}?cursor=${encodeURIComponent(profile.nextConnectionsCursor)}`}>More connections →</Link>}</aside></div>
}
