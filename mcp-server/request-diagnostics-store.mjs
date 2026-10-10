import { safeDiagnosticRecord } from './request-diagnostics.mjs'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const DAY = 86400000, FILE = /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/
// A dedicated mode-700 directory, never the general browser audit file. One
// writer per runtime, at most seven UTC dates / 56 MiB and 128 queued rows.
export async function createDiagnosticsStore({ directory, now = () => new Date(), maxBytes = 8 * 1024 * 1024, maxQueue = 128, retentionDays = 7 } = {}) {
  if (!isAbsolute(directory ?? '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024 || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 128 || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 7) throw new Error('diagnostics_store_configuration_invalid')
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw new Error('diagnostics_directory_not_private')
  let pending = 0, chain = Promise.resolve(), dropped = 0, closed = false, lastPrune = ''
  const stats = { written: 0, dropped: 0, failures: 0 }
  const checkFile = stat => {
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('diagnostics_file_not_private')
  }
  async function prune() {
    const day = now().toISOString().slice(0, 10)
    if (day === lastPrune) return
    const oldest = new Date(Date.parse(day) - (retentionDays - 1) * DAY).toISOString().slice(0, 10)
    const names = await readdir(directory)
    // A single-purpose bounded directory; refuse an unexpected inventory.
    if (names.length > 64) throw new Error('diagnostics_inventory_limit')
    for (const name of names) {
      if (!FILE.test(name) || name.slice(9, 19) >= oldest) continue
      const path = join(directory, name), stat = await lstat(path)
      checkFile(stat)
      await unlink(path)
    }
    lastPrune = day
  }
  await prune()
  const timer = setInterval(() => {
    if (closed || pending >= maxQueue) return
    pending++
    chain = chain.then(prune).catch(() => { stats.failures++ }).finally(() => { pending-- })
  }, 3600000)
  timer.unref()
  return {
    emit(record) {
      if (closed || pending >= maxQueue) { dropped++; stats.dropped++; return }
      // The only caller is the fixed-schema projection in request-diagnostics.
      // No body/header/error object is passed to this sink.
      const snapshot = safeDiagnosticRecord(record)
      if (!snapshot) { dropped++; stats.dropped++; return }
      pending++
      chain = chain.then(async () => {
        await prune()
        const day = now().toISOString().slice(0, 10)
        const filename = `requests-${day}.jsonl`
        const files = (await readdir(directory)).filter(name => FILE.test(name))
        // A backwards clock must not grow beyond the seven-file capacity.
        if (!files.includes(filename) && files.length >= retentionDays) { dropped++; stats.dropped++; return }
        const descriptor = await open(join(directory, filename), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try {
          const stat = await descriptor.stat(); checkFile(stat)
          const line = JSON.stringify({ ...snapshot, sink_dropped_since_last_write: dropped }) + '\n'
          if (Buffer.byteLength(line) > 4096 || stat.size + Buffer.byteLength(line) > maxBytes) { dropped++; stats.dropped++; return }
          await descriptor.writeFile(line); dropped = 0; stats.written++
        } finally { await descriptor.close() }
      }).catch(() => { dropped++; stats.dropped++; stats.failures++ }).finally(() => { pending-- })
    },
    async flush() { await chain },
    async close() { closed = true; clearInterval(timer); await chain },
    stats() { return { ...stats, pending } },
  }
}
