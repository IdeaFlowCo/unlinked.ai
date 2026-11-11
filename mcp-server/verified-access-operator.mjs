import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

// Run only through the existing private operator transport. This is never an
// HTTP endpoint or agent tool; an account cannot verify itself.
export async function operateVerifiedAccess({ session, args, now = () => new Date().toISOString() }) {
  const [action, ownerId, userId, actor, reason] = args
  const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  const text = value => typeof value === 'string' && value.trim() && value.length <= 500
  if (!['show', 'grant', 'revoke'].includes(action) || !id(ownerId) || !id(userId) || (action === 'show' ? args.length !== 3 : args.length !== 5 || !text(actor) || !text(reason))) throw Error('verified_access_arguments_invalid')
  const binding = `MATCH (b:OperationalOwner {namespace:'unlinked',sourceOwnerId:$ownerId,userId:$userId}) WHERE coalesce(b.active,true)=true`
  if (action !== 'show') await session.executeWrite(async tx => {
    const verified = action === 'grant', at = now()
    const result = await tx.run(`${binding}
      SET b.unlinkedVerified=$verified,b.unlinkedVerifiedChangedAt=$at,b.unlinkedVerifiedChangedBy=$actor
      CREATE (e:UnlinkedVerificationEvent {id:$eventId,ownerId:$ownerId,userId:$userId,verified:$verified,at:$at,actor:$actor,reason:$reason})
      RETURN b.sourceOwnerId AS ownerId`, { ownerId, userId, verified, at, actor, reason, eventId: randomUUID() })
    if (result.records.length !== 1) throw Error('verified_access_active_owner_required')
  })
  const result = await session.executeRead(tx => tx.run(`${binding} RETURN b.sourceOwnerId AS ownerId,b.userId AS userId,coalesce(b.unlinkedVerified,false) AS verified,b.unlinkedVerifiedChangedAt AS changedAt,b.unlinkedVerifiedChangedBy AS changedBy`, { ownerId, userId }))
  if (result.records.length !== 1) throw Error('verified_access_active_owner_required')
  return result.records[0].toObject()
}
async function main() {
  const require = createRequire('/srv/unlinked-private-guest-pilot-20261001/runtime/noos/package.json'), neo4j = require('neo4j-driver')
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000 })
  const session = driver.session({ database: 'neo4j' })
  try { console.log(JSON.stringify(await operateVerifiedAccess({ session, args: process.argv.slice(2) }))) }
  finally { await session.close(); await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('verified_access_operation_failed'); process.exitCode = 1 })
