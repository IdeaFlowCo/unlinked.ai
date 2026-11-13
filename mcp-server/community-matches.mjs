// Suggestions use only the already-authorized group projection, never private imports.
const stop = new Set('a an and are as at be been build building can could demo developer developers do for from get give group help i if in into is it looking me my need needs of on or our people please project projects s some someone something that the their them there these they this to use want we what who with working would you your'.split(' '))
const aliases = new Map([['reactjs','react'],['react.js','react'],['nodejs','node'],['node.js','node'],['postgresql','postgres'],['apis','api'],['queries','query'],['tests','testing'],['test','testing']])
function topics(entry) {
  return new Set((`${entry.title} ${entry.body || ''}`.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) || [])
    .map(word => aliases.get(word.replace(/\.$/,'')) || word.replace(/\.$/,''))
    .filter(word => word.length > 2 && !stop.has(word)))
}
const relevance = (a,b) => b.topics.length-a.topics.length || String(a.other.id).localeCompare(String(b.other.id))
export function communityMatches(entries, memberId, limit = 6) {
  if (!memberId) return []
  const open = entries.filter(e => e.memberId && e.status === 'open' && ['ask','offer'].includes(e.kind)).map(entry => ({ entry, topics: topics(entry) }))
  const own = open.filter(e => e.entry.memberId === memberId), others = open.filter(e => e.entry.memberId !== memberId)
  const best = new Map()
  let order = 0
  for (const { entry: mine, topics: mineTopics } of own) for (const { entry: other, topics: theirTopics } of others) {
    if (mine.kind === other.kind) continue
    const shared = [...mineTopics].filter(topic => theirTopics.has(topic)).sort()
    if (!shared.length) continue
    const result = { memberId: other.memberId, name: other.name, mine, other, topics: shared }
    const key = JSON.stringify([other.memberId, mine.kind]), previous = best.get(key)
    if (!previous || relevance(result, previous.result) < 0) best.set(key, { result, order })
    order++
  }
  return [...best.values()].sort((a,b) => relevance(a.result,b.result) || a.order-b.order).slice(0,limit).map(row => row.result)
}
