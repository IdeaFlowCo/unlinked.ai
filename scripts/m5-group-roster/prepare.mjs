#!/usr/bin/env node
// OFFLINE M5 PREPARATION ONLY. Never run on the cloud host. No networking,
// Beeper access, upload, import, messaging, or raw-phone persistence.
import { constants } from 'node:fs'
import { open, lstat, mkdir, rename, unlink, readdir } from 'node:fs/promises'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const fail = code => { throw Error(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const now = () => new Date().toISOString()
const privateDirectory = async path => {
  const st = await lstat(path)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) fail('private_directory_required')
}
const readPrivate = async (path, limit) => {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await fd.stat()
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.size > limit) fail('private_file_required')
    const bytes = await fd.readFile()
    if (bytes.length > limit) fail('file_size_limit')
    return bytes
  } finally { await fd.close() }
}
const syncDirectory = async path => { const fd = await open(path, constants.O_RDONLY); try { await fd.sync() } finally { await fd.close() } }
const writeNew = async (path, bytes) => {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
  await syncDirectory(dirname(path))
}
const replaceManifest = async (path, manifest) => {
  const tmp = join(dirname(path), '.manifest-' + randomUUID())
  await writeNew(tmp, JSON.stringify(manifest, null, 2) + '\n')
  try { await rename(tmp, path); await syncDirectory(dirname(path)) } finally { await unlink(tmp).catch(() => {}) }
}
const parseJson = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('invalid_json') } }
const phone = value => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 64) fail('phone_format_invalid')
  const normalized = value.normalize('NFKC').replace(/[\s().\-‐‑‒–—―]/gu, '')
  // Never guess a country code or convert local/numeric-only input silently.
  if (!/^\+[1-9][0-9]{6,14}$/.test(normalized)) fail('phone_requires_unambiguous_e164')
  return normalized
}
function optionsOf(args) {
  const options = {}
  const allowed = new Set(['input', 'output', 'state-dir', 'expected-hostname', 'expected-rows', 'expected-phones', 'format'])
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--initialize') { if (options.initialize) fail('duplicate_option'); options.initialize = true; continue }
    const key = args[i].replace(/^--/, '')
    if (!args[i].startsWith('--') || !allowed.has(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid_arguments')
    options[key] = args[++i]
  }
  for (const key of ['input', 'output', 'state-dir', 'expected-hostname', 'expected-rows', 'expected-phones']) if (!options[key]) fail('missing_argument')
  for (const key of ['input', 'output', 'state-dir']) {
    if (!isAbsolute(options[key])) fail('absolute_paths_required')
    options[key] = resolve(options[key])
  }
  if (!/^[1-9][0-9]{0,3}$/.test(options['expected-rows']) || !/^[0-9]{1,4}$/.test(options['expected-phones'])) fail('invalid_expected_counts')
  options.rows = Number(options['expected-rows']); options.phones = Number(options['expected-phones'])
  if (options.rows > 2000 || options.phones > options.rows || !['json', 'csv'].includes(options.format ?? 'json')) fail('invalid_expected_counts_or_format')
  options.format ??= 'json'
  if (options.input === options.output || dirname(options.output) === options['state-dir'] || options.output === options['state-dir']) fail('separate_output_required')
  return options
}
function verifyManifest(manifest, key, expectedHost) {
  const allowed = ['schemaVersion', 'algorithm', 'keyId', 'salt', 'hostname', 'createdAt', 'participants', 'lastExport']
  if (!plain(manifest) || Object.keys(manifest).some(k => !allowed.includes(k)) || manifest.schemaVersion !== 1 ||
    manifest.algorithm !== 'HMAC-SHA-256' || manifest.keyId !== digest(key) || manifest.hostname !== expectedHost ||
    typeof manifest.salt !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(manifest.salt) ||
    typeof manifest.createdAt !== 'string' || !plain(manifest.participants) || Object.keys(manifest.participants).length > 10000 ||
    Object.entries(manifest.participants).some(([k, v]) => !HASH.test(k) || !UUID.test(v)) ||
    new Set(Object.values(manifest.participants)).size !== Object.keys(manifest.participants).length) fail('manifest_invalid_or_wrong_key')
}
async function main() {
  const options = optionsOf(process.argv.slice(2))
  if (platform() !== 'darwin' || hostname() !== options['expected-hostname']) fail('verified_m5_host_required')
  process.umask(0o077)
  const state = options['state-dir']
  if (options.initialize) { try { await mkdir(state, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error } }
  await privateDirectory(state); await privateDirectory(dirname(options.output))
  const lockPath = join(state, '.prepare.lock'), lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let key
  try {
    const keyPath = join(state, 'hmac.key'), manifestPath = join(state, 'manifest.json')
    let manifest
    if (options.initialize) {
      if ((await readdir(state)).some(name => name !== '.prepare.lock')) fail('state_already_initialized')
      key = randomBytes(32)
      await writeNew(keyPath, key)
      manifest = { schemaVersion: 1, algorithm: 'HMAC-SHA-256', keyId: digest(key), salt: randomBytes(32).toString('base64'), hostname: hostname(), createdAt: now(), participants: {} }
      await writeNew(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    } else {
      key = await readPrivate(keyPath, 32)
      if (key.length !== 32) fail('key_size_invalid')
      manifest = parseJson(await readPrivate(manifestPath, 2 * 1024 * 1024))
    }
    verifyManifest(manifest, key, options['expected-hostname'])
    const raw = await readPrivate(options.input, 2 * 1024 * 1024), input = parseJson(raw)
    if (!Array.isArray(input) || input.length !== options.rows) fail('unexpected_participant_count')
    const hmac = (domain, value) => createHmac('sha256', key).update(JSON.stringify([domain, manifest.salt, value])).digest('hex')
    const sources = new Set()
    let phones = 0
    const rows = input.map((entry, index) => {
      try {
        if (!plain(entry) || Object.keys(entry).some(k => !['display_name', 'phone', 'participant_id'].includes(k)) || typeof entry.display_name !== 'string') fail('raw_schema_invalid')
        const name = entry.display_name.trim()
        if (!name || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name) || [...name.normalize('NFKC')].filter(ch => /\p{Nd}/u.test(ch)).length >= 7) fail('display_name_invalid_or_phone_like')
        const normalized = phone(entry.phone)
        if (normalized) phones++
        if (entry.participant_id !== undefined && (typeof entry.participant_id !== 'string' || !entry.participant_id || entry.participant_id.length > 512)) fail('source_id_invalid')
        // Raw provider IDs may themselves be phone-bearing. Hash them locally;
        // only a random UUID from the private manifest becomes participant_id.
        const source = entry.participant_id ? ['provider', entry.participant_id] : normalized ? ['phone', normalized] : ['name-only', name.normalize('NFKC')]
        const sourceKey = hmac('unlinked-group-participant-v1', source)
        if (sources.has(sourceKey)) fail('duplicate_source_identity')
        sources.add(sourceKey)
        const participantId = manifest.participants[sourceKey] ??= randomUUID()
        return { display_name: name, phone_hash: normalized ? hmac('unlinked-group-phone-v1', normalized) : null, participant_id: participantId }
      } catch { fail('invalid_participant_at_row_' + (index + 1)) }
    })
    if (phones !== options.phones) fail('unexpected_phone_count')
    if (Object.keys(manifest.participants).length > 10000) fail('manifest_capacity_limit')
    const csv = value => '"' + String(value ?? '').replaceAll('"', '""') + '"'
    const output = options.format === 'json' ? JSON.stringify(rows, null, 2) + '\n' :
      'display_name,phone_hash,participant_id\r\n' + rows.map(r => [r.display_name, r.phone_hash, r.participant_id].map(csv).join(',')).join('\r\n') + '\r\n'
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) fail('prepared_export_size_limit')
    manifest.lastExport = { state: 'prepared', inputSha256: digest(raw), outputSha256: digest(output), rows: rows.length, phones, format: options.format, preparedAt: now() }
    // UUID assignments are durable before any export is created. Retrying with
    // the same manifest/key keeps IDs stable; output paths are never overwritten.
    await replaceManifest(manifestPath, manifest)
    await writeNew(options.output, output)
    manifest.lastExport.state = 'written'
    await replaceManifest(manifestPath, manifest)
    console.log(JSON.stringify({ status: 'prepared_locally_not_imported', rows: rows.length, phones, format: options.format, outputSha256: digest(output) }))
  } finally {
    key?.fill(0)
    await lock.close()
    await unlink(lockPath)
  }
}
main().catch(() => { console.error('Preparation stopped. Check local private paths, M5 host, counts, E.164 input and manifest/key integrity. No upload or import was attempted.'); process.exitCode = 1 })
