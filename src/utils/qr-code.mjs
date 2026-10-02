// Minimal QR encoder: byte mode, error-correction level M, versions 1-10.
// Self-contained so the private runtime adds no new dependency; the test suite
// proves every emitted symbol by decoding it with the existing jsQR dependency.

// Error-correction blocks for level M: version -> [eccPerBlock, [[blocks, dataCodewords], ...]].
const EC_BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
}
const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }

// GF(256) with the QR reducing polynomial x^8+x^4+x^3+x^2+1.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
const multiply = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0

function generatorPolynomial(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0) // poly is most-significant-first
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= multiply(poly[j], EXP[i]) }
    poly = next
  }
  return poly
}

function reedSolomon(data, degree) {
  const generator = generatorPolynomial(degree), remainder = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1); remainder[degree - 1] = 0
    for (let i = 0; i < degree; i++) remainder[i] ^= multiply(generator[i + 1], factor)
  }
  return remainder
}

const dataCapacityBytes = version => {
  const [, blocks] = EC_BLOCKS[version]
  const codewords = blocks.reduce((sum, [count, size]) => sum + count * size, 0)
  const countBits = version <= 9 ? 8 : 16
  return Math.floor((codewords * 8 - 4 - countBits) / 8)
}

export const QR_MAX_BYTES = dataCapacityBytes(10)

function buildCodewords(bytes, version) {
  const [ecc, blockShape] = EC_BLOCKS[version]
  const totalData = blockShape.reduce((sum, [count, size]) => sum + count * size, 0)
  const bits = []
  const append = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  append(0b0100, 4)
  append(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) append(byte, 8)
  append(0, Math.min(4, totalData * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0))
  for (let pad = 0xec; data.length < totalData; pad ^= 0xfd) data.push(pad)
  // Split into blocks (shorter blocks first, as the tables list them), then interleave.
  const blocks = []
  let offset = 0
  for (const [count, size] of blockShape) for (let i = 0; i < count; i++) { const part = data.slice(offset, offset + size); blocks.push({ data: part, ecc: reedSolomon(part, ecc) }); offset += size }
  const result = []
  const longest = Math.max(...blocks.map(block => block.data.length))
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) result.push(block.data[i])
  for (let i = 0; i < ecc; i++) for (const block of blocks) result.push(block.ecc[i])
  return result
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
]

const FINDER_PATTERNS = [[true, false, true, true, true, false, true, false, false, false, false], [false, false, false, false, true, false, true, true, true, false, true]]
function penalty(modules) {
  const size = modules.length
  let score = 0
  const line = read => {
    for (let i = 0; i < size; i++) {
      let run = 1
      for (let j = 1; j <= size; j++) { // runs of five or more same-colored modules
        if (j < size && read(i, j) === read(i, j - 1)) run++
        else { if (run >= 5) score += run - 2; run = 1 }
      }
      for (let j = 0; j + 11 <= size; j++) for (const pattern of FINDER_PATTERNS) { // finder-like 1:1:3:1:1 with light margin
        if (pattern.every((value, index) => read(i, j + index) === value)) { score += 40; break }
      }
    }
  }
  line((i, j) => modules[i][j])
  line((i, j) => modules[j][i])
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const value = modules[y][x]
    if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) score += 3
  }
  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark++
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10
  return score
}

/** Encode text (UTF-8) as a QR matrix: an array of rows of booleans (true = dark). */
export function qrMatrix(text) {
  if (typeof text !== 'string' || !text || /[\x00-\x1f\x7f]/.test(text)) throw new Error('qr_text_required')
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > QR_MAX_BYTES) throw new Error('qr_capacity_exceeded')
  let version = 1
  while (dataCapacityBytes(version) < bytes.length) version++
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, value) => { modules[y][x] = value; reserved[y][x] = true }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy
      if (x < 0 || x >= size || y < 0 || y >= size) continue
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      set(x, y, distance !== 2 && distance !== 4)
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  for (let i = 8; i < size - 8; i++) { if (!reserved[6][i]) set(i, 6, i % 2 === 0); if (!reserved[i][6]) set(6, i, i % 2 === 0) }
  for (const cy of ALIGNMENT[version]) for (const cx of ALIGNMENT[version]) {
    // Only the three centers inside finder corners are omitted; centers on the
    // timing lines are drawn (their pattern is consistent with the timing).
    if ((cx < 9 && cy < 9) || (cx > size - 10 && cy < 9) || (cx < 9 && cy > size - 10)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
  // Reserve both format areas and the dark module before placing data.
  for (let i = 0; i <= 5; i++) { reserved[i][8] = true; reserved[8][i] = true }
  reserved[7][8] = true; reserved[8][7] = true; reserved[8][8] = true
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true }
  set(8, size - 8, true)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3)
      set(a, b, bit); set(b, a, bit)
    }
  }
  // Zigzag data placement over every unreserved module.
  const codewords = buildCodewords(bytes, version)
  const positions = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vertical : vertical
      if (!reserved[y][x]) positions.push([x, y])
    }
  }
  positions.forEach(([x, y], index) => { modules[y][x] = index < codewords.length * 8 && ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1 })
  const formatInfo = mask => {
    const data = (0b00 << 3) | mask // error-correction level M
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    return ((data << 10) | rem) ^ 0x5412
  }
  const drawFormat = mask => {
    const bits = formatInfo(mask), bit = i => ((bits >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) modules[i][8] = bit(i)
    modules[7][8] = bit(6); modules[8][8] = bit(7); modules[8][7] = bit(8)
    for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i)
    for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i)
    for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i)
    modules[size - 8][8] = true
  }
  const applyMask = mask => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x] }
  let best = 0, bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask); drawFormat(mask)
    const score = penalty(modules)
    if (score < bestScore) { bestScore = score; best = mask }
    applyMask(mask)
  }
  applyMask(best); drawFormat(best)
  return modules
}

/** Render a QR matrix as a crisp standalone SVG with the mandatory quiet zone. */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const matrix = qrMatrix(text), size = matrix.length, quiet = 4, side = size + quiet * 2
  let path = ''
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
  const caption = String(label).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="${caption}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#ffffff"/><path d="${path}" fill="#16181d"/></svg>`
}
