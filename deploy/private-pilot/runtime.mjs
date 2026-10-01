#!/usr/bin/env node
// Composition capability must be supplied by the sole application writer.
// This launcher supplies no guessed provider, owner, model or graph defaults.
import { pathToFileURL } from 'node:url'
import { lstat } from 'node:fs/promises'

const root = '/srv/unlinked-private-guest-pilot-20261001'
let dependencies, pilot
const networkMode = process.env.PILOT_NETWORK_MODE ?? 'loopback'
const browserHost = networkMode === 'isolated-container' ? '0.0.0.0' : '127.0.0.1'
const boltUrl = networkMode === 'isolated-container' ? 'bolt://graph:7687' : 'bolt://127.0.0.1:9289'
try {
  if (!['loopback', 'isolated-container'].includes(networkMode) || process.env.PILOT_ROOT !== root || !['https://private.unlinked.ai', 'https://www.unlinked.ai'].includes(process.env.PILOT_ORIGIN) || process.env.PILOT_DATA_MODE !== 'private_live' || process.env.PILOT_HOST !== browserHost || process.env.PILOT_PORT !== '9367' || process.env.PILOT_OPERATIONS_URL !== 'http://127.0.0.1:9022' || process.env.PILOT_BOLT_URL !== boltUrl) throw new Error()
  const wiring = root + '/runtime/wiring.mjs'
  const info = await lstat(wiring)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error()
  const { createPrivatePilotDependencies } = await import(pathToFileURL(wiring).href)
  if (typeof createPrivatePilotDependencies !== 'function') throw new Error()
  dependencies = await createPrivatePilotDependencies({ root, baseUrl: process.env.PILOT_ORIGIN, host: '127.0.0.1', operationalPort: 9022, boltUrl, networkMode, dataMode: 'private_live' })
  for (const key of ['login', 'resolveOwner', 'signup', 'getBackend', 'complete', 'close']) {
    if (typeof dependencies[key] !== (key === 'login' ? 'object' : 'function') || dependencies[key] === null) throw new Error()
  }
  if (!(dependencies.accountGrantKey instanceof Uint8Array) || dependencies.accountGrantKey.length < 32) throw new Error()
  const { startPrivatePilot } = await import(pathToFileURL(root + '/runtime/unlinked/mcp-server/private-pilot.mjs').href)
  pilot = await startPrivatePilot({ ...dependencies, baseUrl: process.env.PILOT_ORIGIN, host: browserHost, port: 9367, networkMode, dataMode: 'private_live' })
  const stop = async () => { await pilot.stop(); await dependencies.close(); process.exit(0) }
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
} catch {
  if (pilot) await pilot.stop().catch(() => {})
  if (dependencies?.close) await dependencies.close().catch(() => {})
  process.stderr.write('private_pilot_runtime_dependencies_unavailable\n')
  process.exitCode = 2
}
