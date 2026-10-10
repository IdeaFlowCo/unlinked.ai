import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { LEGACY_ACCOUNT_SOURCE_SHA256 as SOURCE, assertProductionLegacyAccountManifest, validateLegacyAccountManifest } from './legacy-account-manifest.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

// Offline operator capability only: never mounted as a browser/agent endpoint.
// STDIN receives the private, hash-only manifest made from the verified backup.
export async function operateLegacyAccounts({ action, manifest, profileId, receiptId, links, publicPeople }) {
  if (action === 'revoke') {
    await links.revoke(profileId, receiptId)
    return { action, revoked: true }
  }
  if (action !== 'seed') throw Error('complete_verified_legacy_manifest_required')
  validateLegacyAccountManifest(manifest)
  const snapshot = await publicPeople.read('recovered-legacy-public-v1')
  if (!snapshot || snapshot.state !== 'published' || snapshot.complete !== true || snapshot.revision !== 'legacy-public-v1:' + SOURCE) throw Error('legacy_source_publication_required')
  const ids = new Set(snapshot.profiles.map(value => value.id))
  if (manifest.accounts.some(account => !ids.has(account.profileId))) throw Error('legacy_profile_anchor_missing')
  return { action, ...(await links.seed(manifest)), sourceSha256: SOURCE, ownerBindingsCreated: 0 }
}
async function main() {
  const action = process.argv[2]
  if (!['seed','revoke'].includes(action) || (action === 'seed' && process.argv.length !== 3) || (action === 'revoke' && process.argv.length !== 5)) throw Error('legacy_operator_arguments_invalid')
  let manifest
  if (action === 'seed') {
    const parts=[];let bytes=0
    for await (const part of process.stdin) { bytes+=part.length; if (bytes>65536) throw Error('legacy_manifest_byte_limit'); parts.push(part) }
    manifest=assertProductionLegacyAccountManifest(JSON.parse(Buffer.concat(parts).toString('utf8')))
  }
  const root = '/srv/unlinked-private-guest-pilot-20261001', directory = join(root,'runtime','noos'), require = createRequire(join(directory,'package.json'))
  const neo4j = require('neo4j-driver'), { UnlinkedLegacyLinks } = require(join(directory,'dist/operational/legacy-links.js')), { UnlinkedPublicPeopleStore } = require(join(directory,'dist/operational/public-people.js'))
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j',process.env.NOOS_PRIVATE_PASSWORD),{ connectionTimeout:3000,connectionAcquisitionTimeout:5000,maxTransactionRetryTime:10000 })
  try {
    const links = new UnlinkedLegacyLinks(driver,'neo4j',{role:'operator',actorId:'unlinked-recovered-account-seed',issuer:process.env.IDEAFLOW_ISSUER,clientId:process.env.IDEAFLOW_CLIENT_ID})
    const publicPeople = new UnlinkedPublicPeopleStore(driver,'neo4j')
    await links.initialize(); await publicPeople.initialize()
    const result=await operateLegacyAccounts({action,manifest,profileId:process.argv[3],receiptId:process.argv[4],links,publicPeople})
    process.stdout.write(JSON.stringify({...result,at:new Date().toISOString(),receiptSha256:createHash('sha256').update(JSON.stringify(result)).digest('hex')})+'\n')
  } finally { await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(()=>{process.stderr.write('legacy_account_operation_failed\n');process.exitCode=1})
