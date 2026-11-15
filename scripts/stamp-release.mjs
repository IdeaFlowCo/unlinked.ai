import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const buildTime = new Date().toISOString()
let commit = '', commitTime = null, event = 'build'
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const clean = !git('status', '--porcelain', '--untracked-files=no')
  commit = git('rev-parse', 'HEAD')
  if (clean) { commitTime = git('log', '-1', '--format=%cI', 'HEAD'); event = 'commit' }
} catch { /* Source-only archives honestly use build time. */ }
const info = { version, commit, commitTime, buildTime, event }
writeFileSync(new URL('../public/version.json', import.meta.url), JSON.stringify(info) + '\n')
console.log(JSON.stringify(info))
