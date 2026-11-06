const buffers = new WeakMap()

export async function readRequestBody(request, limit) {
  const cached = buffers.get(request)
  if (cached) {
    if (cached.length > limit) throw new Error('private_body_limit')
    return cached
  }
  const parts = []; let size = 0
  for await (const part of request) {
    size += part.length
    if (size > limit) throw new Error('private_body_limit')
    parts.push(part)
  }
  return Buffer.concat(parts)
}

export async function bufferRequestBody(request, limit) {
  const bytes = await readRequestBody(request, limit)
  buffers.set(request, bytes)
  return bytes
}
