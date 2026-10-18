import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNeo4jSafetyReportStore, REPORT_STATUSES } from './safety-reports.mjs'
import { operatorBoltUrl } from './operator-bolt-url.mjs'

// Operator review of removal requests and reports (docs/removal-requests.md,
// docs/report-and-block.md). Run inside the runtime container; never mounted
// as a browser or agent endpoint. Deciding a report records who and why; it
// changes nothing else (remove a profile with profile-decisions-operator.mjs).
//   node safety-reports-operator.mjs list [open|resolved|dismissed|all] [limit]
//   node safety-reports-operator.mjs show <id>
//   node safety-reports-operator.mjs resolve|dismiss|reopen <id> <decidedBy> <note>
export async function operateSafetyReports({ args, store, now = Date.now }) {
  const [action, ...rest] = args
  const text = value => typeof value === 'string' && value.trim() && value.length <= 2000
  if (action === 'list' && rest.length <= 2) {
    const status = rest[0] ?? 'open', limit = rest[1] === undefined ? 50 : Number(rest[1])
    if ((status !== 'all' && !REPORT_STATUSES.includes(status)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error('safety_report_arguments_invalid')
    return { action, status, reports: await store.list({ status, limit }) }
  }
  if (action === 'show' && rest.length === 1) {
    const report = await store.read(rest[0])
    if (!report) throw Error('safety_report_not_found')
    return { action, report }
  }
  const status = { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open' }[action]
  if (status && rest.length === 3 && text(rest[1]) && text(rest[2])) {
    const report = await store.setStatus(rest[0], { status, by: rest[1], note: rest[2], at: now() })
    if (!report) throw Error('safety_report_not_found')
    return { action, report }
  }
  throw Error('safety_report_arguments_invalid')
}

async function main() {
  const root = '/srv/unlinked-private-guest-pilot-20261001', require = createRequire(join(root, 'runtime', 'noos', 'package.json'))
  const neo4j = require('neo4j-driver')
  const driver = neo4j.driver(operatorBoltUrl(), neo4j.auth.basic('neo4j', process.env.NOOS_PRIVATE_PASSWORD), { connectionTimeout: 3000 })
  try {
    const store = createNeo4jSafetyReportStore(driver)
    await store.initialize()
    process.stdout.write(JSON.stringify(await operateSafetyReports({ args: process.argv.slice(2), store }), null, 1) + '\n')
  } finally { await driver.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
