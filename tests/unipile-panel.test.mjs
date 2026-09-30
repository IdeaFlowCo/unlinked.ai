import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { UnipileLab, LabError } from '../src/utils/unipile-lab.ts'

const require = createRequire(import.meta.url)
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/unipile-lab/panel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function mount(fetch) {
  const states = []
  const effects = []
  let index = 0
  let initial = true
  const react = {
    useState(value) {
      const slot = index++
      if (initial) states[slot] = value
      return [states[slot], next => { states[slot] = next }]
    },
    useCallback(fn) { return fn },
    useEffect(fn) { if (initial) effects.push(fn) },
  }
  const exports = {}
  runInNewContext(compiled, {
    exports, fetch,
    window: { location: { search: '', assign() { throw new Error('Unexpected navigation') } }, setTimeout, clearTimeout },
    URLSearchParams,
    require: name => name === 'react' ? react : name.endsWith('.css') ? { default: {} } : require(name),
  })
  function render() {
    index = 0
    const tree = exports.default()
    initial = false
    return tree
  }
  render()
  effects[0]()
  return render
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('failed Hosted Auth reconnect refreshes quarantined source and preserves its error', async () => {
  for (const refreshFailure of [false, true]) {
    let hosted
    const provider = {
      async hostedLink(input) { hosted = input; return 'https://account.unipile.com/test' },
      async verifyAccount() {},
      async ownProfile() { return { id: 'owner-one', name: 'Private owner preview' } },
    }
    const lab = new UnipileLab(provider, 'demo')
    await lab.start('alice', 'https://test.example')
    const callback = new URL(hosted.notifyUrl)
    await lab.callback({ state: hosted.name, name: hosted.name, token: callback.searchParams.get('token'), status: 'CREATION_SUCCESS', accountId: 'account-one' })
    const failureMessage = 'Preview unavailable.'
    provider.hostedLink = async () => { throw new LabError('unavailable', failureMessage) }
    const requests = []
    const render = mount(async (_url, options) => {
      requests.push(options?.method ?? 'GET')
      if (options?.method === 'POST') {
        assert.equal(JSON.parse(options.body).action, 'reconnect')
        try { await lab.start('alice', 'https://test.example', true) }
        catch { return { ok: false, async json() { return { outcome: 'unavailable', error: failureMessage } } } }
        assert.fail('Hosted Auth must fail')
      }
      if (refreshFailure && requests.length > 1) return { ok: false }
      return { ok: true, async json() { return { ...lab.get('alice'), mode: 'fixture' } } }
    })
    await flush()
    const before = render()
    assert.ok(text(before).includes('Linked · verified by provider'))
    assert.ok(text(before).includes('Private owner preview'))
    nodes(before).find(node => node.type === 'button' && text(node) === 'Reconnect my source').props.onClick()
    await flush()
    const after = render()
    assert.deepEqual(requests, ['GET', 'POST', 'GET'])
    assert.equal(lab.get('alice').sourceStatus, 'quarantined')
    assert.ok(text(after).includes('Unverified · reconnect required'))
    assert.equal(text(after).includes('Private owner preview'), false)
    assert.equal(nodes(after).some(node => node.type === 'button' && text(node) === 'Show up to 10 of my connections'), false)
    assert.equal(text(nodes(after).find(node => node.props?.role === 'alert')), `Outcome: unavailable. ${failureMessage}`)
    if (!refreshFailure) assert.ok(text(after).includes('Connection outcome: unavailable.'))
  }
})
