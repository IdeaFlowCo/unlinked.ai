export function isUnicodeBoundary(text, offset) {
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset)
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
}

export function unicodeChunkEnd(text, start, maxLength) {
  let end = Math.min(text.length, start + maxLength)
  if (!isUnicodeBoundary(text, end)) end--
  return end
}
