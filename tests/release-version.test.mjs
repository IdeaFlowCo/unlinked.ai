import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { Module, createRequire } from 'node:module'
import { createServer } from 'node:http'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPrivateBrowserHandler } from '../mcp-server/private-browser.mjs'
import { Client } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const appPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const mcpPackage = JSON.parse(await readFile(new URL('../mcp-server/package.json', import.meta.url)))

test('anonymous runtime pages expose the app release in their shared footer without owner access', async t => {
  let handler, ownerReads = 0
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  handler = createPrivateBrowserHandler({
    baseUrl: endpoint.replace('http:', 'https:'),
    login: { begin: async () => {}, finish: async () => {} },
    resolveOwner: async () => null,
    getBackend: async () => { ownerReads++; throw Error('unexpected owner read') },
  })
  assert.equal(appPackage.version, '0.4.0')
  for (const path of ['/', '/agents', '/import-linkedin', '/meet']) {
    const response = await fetch(endpoint + path)
    assert.equal(response.status, 200)
    const markup = await response.text()
    const footer = markup.match(/<footer>(.*?)<\/footer>/s)?.[1]
    assert.ok(footer?.includes(`class="app-version">v${appPackage.version}</span>`), path)
    assert.ok(footer.includes('https://worldissuetracker.com/tracker/unlinked-ai'))
    assert.ok(footer.includes('Not affiliated with LinkedIn.'))
  }
  assert.equal(ownerReads, 0)
})

test('Next public shell renders the same package-derived release beside its brand', async () => {
  const filename = new URL('../src/components/PublicShell.tsx', import.meta.url).pathname
  const code = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const loaded = new Module(filename)
  loaded.require = createRequire(filename)
  loaded._compile(code, filename)
  const markup = renderToStaticMarkup(React.createElement(loaded.exports.default, null,
    React.createElement('main', null, 'Public content')))
  assert.match(markup, /<main>Public content<\/main>/)
  assert.ok(markup.includes(`unlinked.ai · <span class="app-version">v${appPackage.version}</span>`))
})

test('legacy stdio initialize advertises the MCP package release and preserves its identity and tools', async t => {
  const directory = await mkdtemp(new URL('../mcp-server/.release-version-', import.meta.url))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // Transpile for execution only: this check exercises the real stdio entrypoint,
  // rather than checking the VERSION declaration or running a static build phase.
  for (const name of ['api', 'server', 'index']) {
    const code = ts.transpileModule(await readFile(new URL(`../mcp-server/src/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
    await writeFile(`${directory}/${name}.js`, code)
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${directory}/index.js`],
    env: { UNLINKED_API_KEY: 'fixture-unused-key', UNLINKED_BASE_URL: 'http://127.0.0.1:1' }, stderr: 'pipe' })
  const client = new Client({ name: 'release-version-fixture', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport)
  assert.equal(mcpPackage.version, '0.3.0')
  assert.deepEqual(client.getServerVersion(), { name: 'unlinked', version: mcpPackage.version })
  const tools = (await client.listTools()).tools.map(tool => tool.name)
  assert.deepEqual(tools, ['unlinked_me', 'unlinked_search_contacts', 'unlinked_get_profile', 'unlinked_list_imports', 'unlinked_draft_intro'])
  if (process.env.RELEASE_VERSION_EVIDENCE) await writeFile(`${process.env.RELEASE_VERSION_EVIDENCE}/legacy-mcp-handshake.json`, JSON.stringify({ serverInfo: client.getServerVersion(), tools }, null, 2))
})
