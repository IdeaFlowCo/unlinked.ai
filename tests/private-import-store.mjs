// Isolated durable test adapter only. This is NOT a production identity,
// authorization, search, or people database and is never imported by app code.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { privateId } from '../src/utils/private-import/job.mjs'

export function isolatedStore(root, { beforePublish } = {}) {
  const ownerPath = ownerId => join(root, privateId(ownerId, 'fixture-owner'))
  async function snapshot(ownerId) {
    try { return JSON.parse(await readFile(join(ownerPath(ownerId), 'snapshot.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { jobs: {}, assertions: {} }; throw error }
  }
  async function commit(ownerId, data) {
    const path = ownerPath(ownerId), temp = join(path, 'snapshot.tmp')
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
    await rename(temp, join(path, 'snapshot.json'))
  }
  const queues = new Map()
  return {
    async withImport(ownerId, _id, work) {
      // Queue local calls, and refuse concurrent external writers rather than
      // guessing whether another process's lock is stale.
      const previous = queues.get(ownerId) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(async () => {
        const path = ownerPath(ownerId)
        await mkdir(path, { recursive: true, mode: 0o700 })
        await mkdir(join(path, 'lock'), { mode: 0o700 })
        try {
          const store = {
            async getJob(id) { return (await snapshot(ownerId)).jobs[id] ?? null },
            async saveJob(job) {
              const data = await snapshot(ownerId)
              data.jobs[job.id] = structuredClone(job)
              await commit(ownerId, data)
            },
            async putAsset(hash, bytes) {
              const assetPath = join(path, 'assets')
              await mkdir(assetPath, { recursive: true, mode: 0o700 })
              try { await writeFile(join(assetPath, hash), bytes, { mode: 0o600, flag: 'wx' }) }
              catch (error) {
                if (error.code !== 'EEXIST') throw error
                if (!(await readFile(join(assetPath, hash))).equals(bytes)) throw new Error('immutable_asset_conflict')
              }
            },
            async publish(job, assertions) {
              if (beforePublish) await beforePublish()
              const data = await snapshot(ownerId)
              for (const assertion of assertions) {
                if (assertion.ownerId !== ownerId) throw new Error('owner_mismatch')
                const previous = data.assertions[assertion.id]
                if (previous && JSON.stringify(previous) !== JSON.stringify(assertion)) throw new Error('immutable_assertion_conflict')
                data.assertions[assertion.id] = assertion
              }
              data.jobs[job.id] = structuredClone(job)
              await commit(ownerId, data)
            },
          }
          // Mark infrastructure failures so ingest never reports success/failure
          // of the archive when persistence itself is unavailable.
          for (const key of Object.keys(store)) {
            const operation = store[key]
            store[key] = async (...args) => {
              try { return await operation(...args) }
              catch (error) { error.persistenceFailure = true; throw error }
            }
          }
          return await work(store)
        } finally { await rm(join(path, 'lock'), { recursive: true }) }
      })
      queues.set(ownerId, next)
      return next
    },
    async job(ownerId, id) { return (await snapshot(ownerId)).jobs[id] ?? null },
    async assertions(ownerId) { return Object.values((await snapshot(ownerId)).assertions) },
    async asset(ownerId, hash) {
      try { return await readFile(join(ownerPath(ownerId), 'assets', hash)) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
  }
}
