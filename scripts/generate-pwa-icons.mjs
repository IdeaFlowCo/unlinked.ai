// Regenerates the committed PWA icons (public/app-icon-*.png) with no image
// dependency: plain RGBA rasterization of the Unlinked mark (two separated
// link segments on the brand indigo) encoded as PNG by hand via zlib.
// Run: node scripts/generate-pwa-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = bytes => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw.set([r, g, b, a], row + 1 + x * 4)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const INDIGO = [0x43, 0x49, 0xc4], WHITE = [0xff, 0xff, 0xff]
// Signed distance to a rounded capsule between two points (in unit space).
const capsule = (px, py, ax, ay, bx, by, radius) => {
  const abx = bx - ax, aby = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t)) - radius
}
// The mark: a chain link broken apart — two diagonal capsule segments with a
// clear gap between them. Drawn in [0,1]² unit coordinates.
const markDistance = (u, v) => Math.min(
  capsule(u, v, 0.30, 0.70, 0.42, 0.58, 0.085),
  capsule(u, v, 0.58, 0.42, 0.70, 0.30, 0.085))

function icon(size, { maskable }) {
  // Maskable icons keep the glyph inside the 40% safe zone on a full-bleed
  // background; the plain icon gets a rounded square with transparent corners.
  const cornerRadius = maskable ? 0 : size * 0.18
  const pad = maskable ? 0.12 : 0
  return png(size, (x, y) => {
    const samples = 4
    let inside = 0, glyph = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples
      const dx = Math.max(cornerRadius - px, px - (size - cornerRadius), 0)
      const dy = Math.max(cornerRadius - py, py - (size - cornerRadius), 0)
      if (!maskable && Math.hypot(dx, dy) > cornerRadius) continue
      inside++
      const u = pad + (px / size) * (1 - 2 * pad), v = pad + (py / size) * (1 - 2 * pad)
      if (markDistance(u, v) < 0) glyph++
    }
    const total = samples * samples
    if (!inside) return [0, 0, 0, 0]
    const g = glyph / inside
    const color = INDIGO.map((channel, index) => Math.round(channel * (1 - g) + WHITE[index] * g))
    return [...color, Math.round(255 * inside / total)]
  })
}

const root = new URL('../', import.meta.url)
await writeFile(fileURLToPath(new URL('public/app-icon-192.png', root)), icon(192, { maskable: false }))
await writeFile(fileURLToPath(new URL('public/app-icon-512.png', root)), icon(512, { maskable: false }))
await writeFile(fileURLToPath(new URL('public/app-icon-maskable-512.png', root)), icon(512, { maskable: true }))
console.log('wrote public/app-icon-192.png, app-icon-512.png, app-icon-maskable-512.png')
