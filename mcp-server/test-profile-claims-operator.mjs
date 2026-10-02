import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { operateTestProfileClaims } from './test-profiles.mjs'

// Operator capability only, run inside the runtime container; never mounted as
// a browser or agent endpoint. Works on claims of TEST profiles only
// (test-profiles.mjs); real claims are revoked with legacy-account-operator.mjs.
//   node test-profile-claims-operator.mjs list
//   node test-profile-claims-operator.mjs release <testProfileId>
// `release` deletes the claim row, which is all that blocks claiming again:
// the same test profile and the same account/address can claim afresh. It
// refuses any other profile id, and refuses (deleting nothing) if a claim on
// the test profile is not itself marked as a test claim.
async function main() {
  const root = '/srv/unlinked-private-guest-pilot-20261001', require = createRequire(join(root, 'runtime', 'noos', 'package.json'))
  const neo4j = require('neo4j-driver')
  const driver = neo4j.driver('bolt://graph:7687', neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000, connectionAcquisitionTimeout: 5000, maxTransactionRetryTime: 10000 })
  const session = driver.session({ database: 'neo4j' })
  try {
    const result = await operateTestProfileClaims({ args: process.argv.slice(2), session })
    process.stdout.write(JSON.stringify({ ...result, receiptSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') }, null, 1) + '\n')
  } finally { await session.close(); await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
