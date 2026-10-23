import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'
import { parseLinkedinProfileUrl } from '../src/utils/linkedin-profile-url.mjs'
import { linkedinRefHash, linkedinSlug, normalizeLinkedinSlug } from '../src/utils/public-people/url-identity.mjs'

// Operator capability only, run inside the runtime container; never mounted as a
// browser or agent endpoint. Every decision records who decided and why, and is
// revoked rather than deleted, so the published projection can always be restored.
//   node profile-decisions-operator.mjs list
//   node profile-decisions-operator.mjs merge <mergedId> <survivorId> <decidedBy> <evidence>
//   node profile-decisions-operator.mjs rename <profileId> <name> <decidedBy> <reason>
//   node profile-decisions-operator.mjs remove <profileId> <decidedBy> <reason>   (an imported profile; members are never removed)
//   node profile-decisions-operator.mjs unlist <profileId> <group|-> <decidedBy> <reason>   (published, but out of listings; `-` = for everyone)
//   node profile-decisions-operator.mjs suspend <profileId> <decidedBy> <reason> [linkedinUrl]   (reversible soft delete of any profile, members included)
//   node profile-decisions-operator.mjs restore <suspendDecisionId> <decidedBy> <reason>
//   node profile-decisions-operator.mjs revoke <decisionId> <decidedBy>
// A suspension (docs/profile-suspension.md) stores only the SHA-256 of the
// person's LinkedIn slug, found from the recovered legacy source or the
// import row (`linkedinRefFor`), or from the optional address argument.
export async function operateProfileDecisions({ args, session, now = () => new Date().toISOString(), linkedinRefFor = async () => null }) {
  const [action, ...rest] = args
  const active = async () => (await session.executeRead(tx => tx.run('MATCH (d:UnlinkedProfileDecision) WHERE coalesce(d.revoked, false) = false RETURN properties(d) AS d ORDER BY d.decidedAt'))).records.map(record => record.get('d'))
  if (action === 'list' && rest.length === 0) return { action, decisions: await active() }
  const text = value => typeof value === 'string' && value.trim() && value.length <= 2000
  if (action === 'merge' || action === 'rename') {
    const [profileId, value, decidedBy, why] = rest
    if (rest.length !== 4 || !text(decidedBy) || !text(why)) throw Error('profile_decision_arguments_invalid')
    const decision = { id: randomUUID(), kind: action, profileId, ...(action === 'merge' ? { survivorId: value, evidence: why } : { name: value, reason: why }), decidedBy, decidedAt: now(), revoked: false }
    // The new decision must keep the whole active set valid (no chains, no repeats).
    validateProfileDecisions([...(await active()).map(value => ({ ...value })), decision])
    await session.executeWrite(tx => tx.run('CREATE (d:UnlinkedProfileDecision) SET d = $decision', { decision }))
    return { action, decision }
  }
  if (action === 'remove') {
    // Removal requests (docs/removal-requests.md): the reason names the request, e.g. "removal request <id>".
    const [profileId, decidedBy, reason] = rest
    if (rest.length !== 3 || !text(decidedBy) || !text(reason)) throw Error('profile_decision_arguments_invalid')
    const decision = { id: randomUUID(), kind: 'remove', profileId, reason, decidedBy, decidedAt: now(), revoked: false }
    validateProfileDecisions([...(await active()).map(value => ({ ...value })), decision])
    await session.executeWrite(tx => tx.run('CREATE (d:UnlinkedProfileDecision) SET d = $decision', { decision }))
    return { action, decision }
  }
  if (action === 'unlist') {
    // Unlisted profiles (docs/unlisted-profiles.md): kept published, left out of
    // the directory, search and suggestions. A group (e.g. `appreview`) lets
    // profiles unlisted in that group still see each other.
    const [profileId, group, decidedBy, reason] = rest
    if (rest.length !== 4 || typeof group !== 'string' || !text(decidedBy) || !text(reason)) throw Error('profile_decision_arguments_invalid')
    const decision = { id: randomUUID(), kind: 'unlist', profileId, ...(group === '-' ? {} : { group }), reason, decidedBy, decidedAt: now(), revoked: false }
    validateProfileDecisions([...(await active()).map(value => ({ ...value })), decision])
    await session.executeWrite(tx => tx.run('CREATE (d:UnlinkedProfileDecision) SET d = $decision', { decision }))
    return { action, decision }
  }
  if (action === 'suspend') {
    const [profileId, decidedBy, reason, address] = rest
    if (rest.length < 3 || rest.length > 4 || !text(decidedBy) || !text(reason)) throw Error('profile_decision_arguments_invalid')
    let ref = null
    if (address === '-') ref = null
    else if (address !== undefined) {
      const parsed = parseLinkedinProfileUrl(address)
      if (!parsed) throw Error('profile_decision_arguments_invalid')
      ref = linkedinRefHash(parsed.slug)
    } else {
      ref = await linkedinRefFor(profileId)
      // Without a stored LinkedIn identity a later import could re-list the
      // person, so the operator must give the address, or `-` to accept that.
      if (!ref) throw Error('profile_decision_linkedin_required')
    }
    const decision = { id: randomUUID(), kind: 'suspend', profileId, ...(ref ? { linkedinRefHash: ref } : {}), reason, decidedBy, decidedAt: now(), revoked: false }
    validateProfileDecisions([...(await active()).map(value => ({ ...value })), decision])
    await session.executeWrite(tx => tx.run('CREATE (d:UnlinkedProfileDecision) SET d = $decision', { decision }))
    return { action, decision }
  }
  if (action === 'restore') {
    const [id, decidedBy, reason] = rest
    if (rest.length !== 3 || !text(id) || !text(decidedBy) || !text(reason)) throw Error('profile_decision_arguments_invalid')
    const result = await session.executeWrite(tx => tx.run("MATCH (d:UnlinkedProfileDecision {id: $id, kind: 'suspend'}) WHERE coalesce(d.revoked, false) = false SET d.revoked = true, d.revokedAt = $now, d.revokedBy = $by, d.restoreReason = $reason RETURN d.id AS id", { id, now: now(), by: decidedBy, reason }))
    if (result.records.length !== 1) throw Error('profile_decision_not_found')
    return { action, restored: id }
  }
  if (action === 'revoke' && rest.length === 2 && text(rest[1])) {
    // Suspensions are lifted only with `restore`, which records why.
    const result = await session.executeWrite(tx => tx.run("MATCH (d:UnlinkedProfileDecision {id: $id}) WHERE coalesce(d.revoked, false) = false AND coalesce(d.kind, '') <> 'suspend' SET d.revoked = true, d.revokedAt = $now, d.revokedBy = $by RETURN d.id AS id", { id: rest[0], now: now(), by: rest[1] }))
    if (result.records.length !== 1) throw Error('profile_decision_not_found')
    return { action, revoked: rest[0] }
  }
  throw Error('profile_decision_arguments_invalid')
}

async function main() {
  const root = '/srv/unlinked-private-guest-pilot-20261001', require = createRequire(join(root, 'runtime', 'noos', 'package.json'))
  const neo4j = require('neo4j-driver')
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000 })
  const session = driver.session({ database: 'neo4j' })
  try {
    await session.executeWrite(tx => tx.run('CREATE CONSTRAINT unlinked_profile_decision_id IF NOT EXISTS FOR (d:UnlinkedProfileDecision) REQUIRE d.id IS UNIQUE'))
    // The LinkedIn identity of a recovered legacy profile or an imported `public-<row>` person.
    const linkedinRefFor = async profileId => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId)) {
        const directory = join(root, 'audit')
        for (const name of (await readdir(directory)).filter(value => /^legacy-public-source-manifest-[a-f0-9]{64}\.json$/.test(value)).sort()) {
          const row = (JSON.parse(await readFile(join(directory, name), 'utf8')).profiles ?? []).find(value => value.legacyId === profileId)
          const slug = row?.linkedinSlug ? normalizeLinkedinSlug(String(row.linkedinSlug)) : null
          if (slug) return linkedinRefHash(slug)
        }
        return null
      }
      if (profileId.startsWith('public-')) {
        const result = await session.executeRead(tx => tx.run("MATCH (a:OperationalResource {namespace: 'unlinked', type: 'assertion', sourceId: $id}) RETURN a.document AS document LIMIT 1", { id: profileId.slice('public-'.length) }))
        let subject = null
        try { subject = JSON.parse(result.records[0]?.get('document') ?? 'null')?.payload?.subject ?? null } catch { subject = null }
        const slug = linkedinSlug(subject)
        return slug ? linkedinRefHash(slug) : null
      }
      return null
    }
    process.stdout.write(JSON.stringify(await operateProfileDecisions({ args: process.argv.slice(2), session, linkedinRefFor }), null, 1) + '\n')
  } finally { await session.close(); await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
