import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { validateProfileDecisions } from '../src/utils/public-people/profile-decisions.mjs'

// Operator capability only, run inside the runtime container; never mounted as a
// browser or agent endpoint. Every decision records who decided and why, and is
// revoked rather than deleted, so the published projection can always be restored.
//   node profile-decisions-operator.mjs list
//   node profile-decisions-operator.mjs merge <mergedId> <survivorId> <decidedBy> <evidence>
//   node profile-decisions-operator.mjs rename <profileId> <name> <decidedBy> <reason>
//   node profile-decisions-operator.mjs revoke <decisionId> <decidedBy>
export async function operateProfileDecisions({ args, session, now = () => new Date().toISOString() }) {
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
  if (action === 'revoke' && rest.length === 2 && text(rest[1])) {
    const result = await session.executeWrite(tx => tx.run('MATCH (d:UnlinkedProfileDecision {id: $id}) WHERE coalesce(d.revoked, false) = false SET d.revoked = true, d.revokedAt = $now, d.revokedBy = $by RETURN d.id AS id', { id: rest[0], now: now(), by: rest[1] }))
    if (result.records.length !== 1) throw Error('profile_decision_not_found')
    return { action, revoked: rest[0] }
  }
  throw Error('profile_decision_arguments_invalid')
}

async function main() {
  const root = '/srv/unlinked-private-guest-pilot-20261001', require = createRequire(join(root, 'runtime', 'noos', 'package.json'))
  const neo4j = require('neo4j-driver')
  const driver = neo4j.driver('bolt://graph:7687', neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000 })
  const session = driver.session({ database: 'neo4j' })
  try {
    await session.executeWrite(tx => tx.run('CREATE CONSTRAINT unlinked_profile_decision_id IF NOT EXISTS FOR (d:UnlinkedProfileDecision) REQUIRE d.id IS UNIQUE'))
    process.stdout.write(JSON.stringify(await operateProfileDecisions({ args: process.argv.slice(2), session }), null, 1) + '\n')
  } finally { await session.close(); await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
