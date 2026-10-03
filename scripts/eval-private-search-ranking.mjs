// Opt-in development evaluation; sends only the fictional fixture to the model.
// Uses the existing M5 credential bridge; never copies or prints credentials.
// Run: node scripts/eval-private-search-ranking.mjs [baseline git ref]
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createPrivateSearch } from '../src/utils/private-import/ai-search.mjs'
import { createRemoteCompletion } from './private-remote-completion.mjs'
import { COMBINED_UPLOAD_CONSENT } from '../src/utils/private-import/consent.mjs'
import { searchPeople } from '../tests/fixtures/private-search-people.mjs'

const baselineRef = process.argv[2] ?? '60067d8'
const baselineSource = execFileSync('git', ['show', `${baselineRef}:src/utils/private-import/ai-search.mjs`], { encoding: 'utf8' })
  .replaceAll("'./consent.mjs'", JSON.stringify(new URL('../src/utils/private-import/consent.mjs', import.meta.url).href))
  .replaceAll("'./archive.mjs'", JSON.stringify(new URL('../src/utils/private-import/archive.mjs', import.meta.url).href))
const baselineUrl = 'data:text/javascript;base64,' + Buffer.from(baselineSource).toString('base64')
const before = await import(baselineUrl)
const bridgeSource = (await readFile(new URL('./private-remote-completion.mjs', import.meta.url), 'utf8'))
  .replace("'../src/utils/private-import/ai-search.mjs'", JSON.stringify(baselineUrl))
const beforeBridge = await import('data:text/javascript;base64,' + Buffer.from(bridgeSource).toString('base64'))
const publication = { consent: COMBINED_UPLOAD_CONSENT, indexed: searchPeople.length, assertions: searchPeople }
const query = 'Find investors in my network who invest in gaming companies'
for (const [scenario, assertions] of [['explicit-sector', searchPeople], ['unknown-sector', searchPeople.filter(row => row.fields['first name'] !== 'Gaming Investor')]]) {
for (const [label, factory, bridge] of [['before', before.createPrivateSearch, beforeBridge.createRemoteCompletion], ['after', createPrivateSearch, createRemoteCompletion]]) {
  const receipts = [], start = performance.now()
  const complete = bridge({ sshHost: 'm5', credentialFile: '/Users/jacobcole/.config/openai/openai.env', onReceipt: value => receipts.push(value) })
  const result = await factory({ readImport: async () => ({ ...publication, indexed: assertions.length, assertions }), complete })({ importId: 'a'.repeat(64), query })
  console.log(JSON.stringify({ scenario, label, baselineRef, query, elapsedMs: Math.round(performance.now() - start), considered: result.considered, receipts,
    matches: result.matches.map(match => ({ name: match.fields['first name'], position: match.fields.position, company: match.fields.company, reason: match.reason })) }, null, 2))
}
}
