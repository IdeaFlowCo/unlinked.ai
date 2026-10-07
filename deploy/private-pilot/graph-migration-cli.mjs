#!/usr/bin/env node
import { createRequire } from 'node:module'
import { readFile, open, lstat } from 'node:fs/promises'
import { exportGraph, exportSharedGraph, importGraph, restoreIsolatedGraph, verifyGraph, rollbackGraph } from './graph-migration.mjs'

// Operator-only: no HTTP route, no credentials in arguments or output.
const [action, file, id] = process.argv.slice(2)
try {
  if (!['export', 'export-shared', 'import', 'restore-isolated', 'verify', 'rollback'].includes(action) || !file) throw new Error('usage_graph_migration_action_file_id')
  const moduleRoot = process.env.MIGRATION_NEO4J_MODULE_ROOT
  if (!moduleRoot?.startsWith('/')) throw new Error('explicit_driver_module_root_required')
  const neo4j = createRequire(moduleRoot + '/package.json')('neo4j-driver')
  const uri = process.env.MIGRATION_NEO4J_URI, password = process.env.MIGRATION_NEO4J_PASSWORD
  if (!uri || !password) throw new Error('explicit_graph_credentials_required')
  const driver = neo4j.driver(uri, neo4j.auth.basic(process.env.MIGRATION_NEO4J_USER || 'neo4j', password))
  try {
    if (action === 'export' || action === 'export-shared') {
      const snapshot = await (action === 'export' ? exportGraph(driver, neo4j) : exportSharedGraph(driver, neo4j, id))
      const out = await open(file, 'wx', 0o600)
      try { await out.writeFile(JSON.stringify(snapshot)); await out.sync() } finally { await out.close() }
      console.log(JSON.stringify({ action, nodes: snapshot.nodes.length, manifestHash: snapshot.manifestHash }))
    } else {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('private_regular_snapshot_required')
      const snapshot = JSON.parse(await readFile(file, 'utf8'))
      const result = await ({ import: importGraph, 'restore-isolated': restoreIsolatedGraph, verify: verifyGraph, rollback: rollbackGraph }[action])(driver, neo4j, snapshot, id)
      console.log(JSON.stringify({ action, ...result }))
    }
  } finally { await driver.close() }
} catch (error) {
  // Driver errors can include parameters/data. Print only a known code/name.
  const message = /^[a-z_]+$/.test(error.message) ? error.message : (error.code || error.name)
  console.error(JSON.stringify({ error: message })); process.exitCode = 1
}
