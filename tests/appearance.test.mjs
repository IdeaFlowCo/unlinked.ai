import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { APPEARANCE_INIT, APPEARANCE_SCRIPT } from '../mcp-server/appearance.mjs'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { renderPeople, renderLanding } from '../mcp-server/private-onboarding-views.mjs'

test('only a saved light or dark override is applied before paint; unavailable storage follows system', () => {
  for (const [saved, mode] of [[null,'system'],['system','system'],['dark','dark'],['light','light'],['invalid','system']]) {
    const document = { documentElement: { dataset: {} } }
    vm.runInNewContext(APPEARANCE_INIT, { document, localStorage: { getItem: () => saved } })
    assert.equal(document.documentElement.dataset.appearance, mode)
  }
  const document = { documentElement: { dataset: {} } }
  vm.runInNewContext(APPEARANCE_INIT, { document, localStorage: { getItem: () => { throw Error('blocked') } } })
  assert.equal(document.documentElement.dataset.appearance, 'system')
  assert.doesNotThrow(() => new vm.Script(APPEARANCE_SCRIPT))
})

test('visitors and members can choose all three appearances in a labelled native control', () => {
  for (const view of [renderLanding(), renderPeople({ csrf:'fictional-csrf', displayName:'Sam Rivera' })]) {
    const header = view.content.match(/<header>(.*?)<\/header>/s)[1]
    assert.match(header, /<summary aria-label="Change appearance"/)
    assert.match(header, /<label for="appearance-mode">Appearance<\/label>/)
    assert.match(header, /<select id="appearance-mode" aria-describedby="appearance-hint">/)
    assert.match(header, /<option value="system">System<\/option><option value="light">Light<\/option><option value="dark">Dark<\/option>/)
    assert.equal(view.content.match(/id="appearance-mode"/g).length, 1)
  }
})

test('canonical and discovery documents initialize appearance before body content under the response nonce', async t => {
  let handler
  const server = createServer((req,res) => handler(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({ baseUrl: endpoint.replace('http:', 'https:'), login: { begin:async()=>{}, finish:async()=>{} }, resolveOwner:async()=>null, getBackend:async()=>{ throw Error('unexpected owner read') } })
  for (const [path,status] of [['/',200], ['/join',200], ['/agents',200], ['/support',200], ['/meet',200], ['/settings',401]]) {
    const response = await fetch(endpoint + path)
    assert.equal(response.status, status, path)
    const source = await response.text()
    const nonce = response.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1]
    assert.ok(source.includes(`<script nonce="${nonce}">${APPEARANCE_INIT}</script>`), path)
    assert.ok(source.indexOf(APPEARANCE_INIT) < source.indexOf('<style>'), path)
    if (status === 200) assert.ok(source.includes(APPEARANCE_SCRIPT), path)
  }
})
