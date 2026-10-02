import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { qrMatrix, qrSvg, QR_MAX_BYTES } from '../src/utils/qr-code.mjs'

// The encoder is proved by the decoder the product already ships for scanning.
const jsQR = createRequire(import.meta.url)('jsqr')

const rasterize = matrix => {
  const quiet = 4, scale = 4, side = (matrix.length + quiet * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x])
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const index = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4
      data[index] = data[index + 1] = data[index + 2] = 0
    }
  return { data, side }
}
const decode = matrix => { const { data, side } = rasterize(matrix); return jsQR(data, side, side) }

test('every supported version round-trips through the shipped jsQR decoder', () => {
  const texts = [
    'A',
    'https://www.unlinked.ai/people/c2d609ce-fa01-4a8f-8dcc-710292e4a56c',
    `https://www.unlinked.ai/people/member-import-${'ab'.repeat(32)}`,
    'Ünïcødé ✓ bytes',
    ...Array.from({ length: 30 }, (_, index) => 'u'.repeat(index * 7 + 1)),
    'z'.repeat(QR_MAX_BYTES),
  ]
  const sizes = new Set()
  for (const text of texts) {
    const matrix = qrMatrix(text)
    sizes.add(matrix.length)
    const decoded = decode(matrix)
    assert.ok(decoded, `decodable: ${JSON.stringify(text.slice(0, 40))}`)
    assert.equal(decoded.data, text)
  }
  assert.ok(sizes.has(21) && sizes.has(57), 'exercises version 1 through version 10')
})

test('rejects unencodable input instead of emitting a wrong code', () => {
  assert.throws(() => qrMatrix(''), /qr_text_required/)
  assert.throws(() => qrMatrix(null), /qr_text_required/)
  assert.throws(() => qrMatrix('line\nbreak'), /qr_text_required/)
  assert.throws(() => qrMatrix('nul\x00byte'), /qr_text_required/)
  assert.throws(() => qrMatrix('z'.repeat(QR_MAX_BYTES + 1)), /qr_capacity_exceeded/)
  assert.throws(() => qrMatrix('✓'.repeat(Math.ceil(QR_MAX_BYTES / 3) + 1)), /qr_capacity_exceeded/)
})

test('SVG rendering keeps the quiet zone, escapes the label and embeds no data: URI', () => {
  const url = 'https://www.unlinked.ai/people/abc'
  const svg = qrSvg(url, { label: `QR code opening ${url} <&"'>` })
  const side = qrMatrix(url).length + 8
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`))
  assert.match(svg, /role="img"/)
  assert.match(svg, /aria-label="QR code opening https:\/\/www\.unlinked\.ai\/people\/abc &lt;&amp;&quot;&#39;&gt;"/)
  assert.doesNotMatch(svg, /data:/)
  assert.doesNotMatch(svg, /<script/i)
})
