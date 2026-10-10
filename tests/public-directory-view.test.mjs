import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Module, createRequire } from 'node:module'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Execute the TSX component with the real React/Next renderer; CSS is presentation-only.
const code = ts.transpileModule(await readFile(new URL('../src/components/public-directory/People.tsx', import.meta.url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const filename = new URL('../src/components/public-directory/People.tsx', import.meta.url).pathname
const loaded = new Module(filename), require = createRequire(filename)
loaded.require = name => name.endsWith('.module.css') ? new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) }) : require(name)
loaded._compile(code, filename)
const { ProfileBody, PeopleList, DirectoryNotice } = loaded.exports
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props))

test('public profile renders supplied sections and public connections without invented mutuals', () => {
  const profile = { id: 'synthetic', name: 'Synthetic Person', headline: 'Engineer', location: 'Test City', about: 'Published about text', positions: [{ title: 'Engineer', company: 'Synthetic Company', startDate: '2020', description: 'Published position' }], education: [{ institution: 'Synthetic School', degree: 'Test Degree' }], skills: ['Research'], connections: [{ id: 'other/id', name: 'Other Person' }] }
  const html = render(ProfileBody, { profile })
  for (const content of ['Synthetic Person', 'Published about text', 'Experience', 'Synthetic Company', 'Education', 'Synthetic School', 'Research', 'Other Person']) assert.ok(html.includes(content))
  assert.ok(html.includes('/people/other%2Fid'))
  assert.ok(!html.includes('mutual'))
  assert.ok(!html.includes('Add friend'))
})
test('public output escapes supplied content and keeps unavailable distinct from empty and missing', () => {
  const html = render(PeopleList, { people: [{ id: 'x', name: '<script>alert(1)</script>' }] })
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  const unavailable = render(DirectoryNotice, { kind: 'unavailable' }), empty = render(DirectoryNotice, { kind: 'empty' }), missing = render(DirectoryNotice, { kind: 'not-found' })
  assert.ok(unavailable.includes('not connected yet'))
  assert.ok(empty.includes('No profiles match'))
  assert.ok(missing.includes('could not be found'))
  assert.notEqual(unavailable, empty)
})

test('retained Next.js profile renders valid professional links and rejects unsafe URLs', () => {
  const profile = { id: 'synthetic', name: 'Synthetic Person', positions: [], education: [], skills: [], connections: [], company: 'Test Company', industry: 'Research', linkedinUrl: 'https://www.linkedin.com/in/test-person', website: 'https://example.test' }
  const html = render(ProfileBody, { profile })
  assert.match(html, /href="https:\/\/www.linkedin.com\/in\/test-person" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /href="https:\/\/example.test\/"/)
  assert.match(html, /href="\/companies\/Test%20Company"/)
  const unsafe = render(ProfileBody, { profile: { ...profile, linkedinUrl: 'javascript:alert(1)', website: 'https://u:p@example.test' } })
  assert.doesNotMatch(unsafe, /href="javascript:|href="https:\/\/u:p/)
})
