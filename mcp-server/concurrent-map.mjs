export async function concurrentMap(items, project) {
  const results = new Array(items.length)
  let next = 0, failed = false
  const worker = async () => {
    while (!failed) {
      const index = next++
      if (index >= items.length) return
      try { results[index] = await project(items[index], index) }
      catch (error) { failed = true; throw error }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker))
  return results
}
