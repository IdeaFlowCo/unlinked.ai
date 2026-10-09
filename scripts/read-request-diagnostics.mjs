#!/usr/bin/env node
import { constants } from 'node:fs'
import { lstat, readdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'

export async function readDiagnostics({ directory, requestId, accountId, since } = {}) {
  if (!isAbsolute(directory ?? '') || Boolean(requestId) === Boolean(accountId) || requestId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId) || accountId && !/^[a-f0-9]{64}$/.test(accountId) || since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(since) || !Number.isFinite(Date.parse(since)))) throw new Error('diagnostics_filter_required')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('diagnostics_directory_not_private')
  const files = await readdir(directory), records = []
  if (files.length > 64) throw new Error('diagnostics_inventory_limit')
  for (const file of files.filter(value => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(value)).sort().reverse()) {
    const descriptor = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await descriptor.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) throw new Error('diagnostics_file_not_private')
      for (const line of (await descriptor.readFile('utf8')).split('\n')) {
        if (!line || Buffer.byteLength(line) > 4096) continue
        let record
        try { record = safeDiagnosticRecord(JSON.parse(line)) } catch { continue }
        if (!record || requestId && record.request_id !== requestId || accountId && record.account_id !== accountId || since && (!record.at || Date.parse(record.at) < Date.parse(since))) continue
        if (records.length === 500) return { records, truncated: true }
        records.push(record)
      }
    } finally { await descriptor.close() }
  }
  return { records, truncated: false }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = { '--directory': 'directory', '--request-id': 'requestId', '--account-id': 'accountId', '--since': 'since' }, options = {}
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = flags[process.argv[i]]
      if (!key || options[key] || !process.argv[i + 1]) throw new Error('diagnostics_filter_required')
      options[key] = process.argv[i + 1]
    }
    process.stdout.write(JSON.stringify(await readDiagnostics(options), null, 2) + '\n')
  } catch { process.stderr.write('Diagnostics unavailable: check private operator access, directory and exact request/account filter.\n'); process.exitCode = 1 }
}
