import { once } from 'node:events'

export function networkExportInput(params) {
  if ([...params.keys()].some(key => !['scope', 'q', 'ids'].includes(key)) || ['scope', 'q', 'ids'].some(key => params.getAll(key).length > 1)) throw Error('network_export_input_invalid')
  const scope = params.get('scope') || 'everyone', query = params.get('q') || '', raw = params.get('ids') || ''
  const ids = raw.split(/[\s,]+/).filter(Boolean)
  if (!['everyone', 'mine'].includes(scope) || query.length > 200 || raw.length > 10000 || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw Error('network_export_input_invalid')
  return { scope, query, ids: [...new Set(ids)] }
}

// JSON Lines keeps a whole graph download out of the browser and main heap.
// A complete footer is required: interrupted downloads never look complete.
export async function streamNetworkExport({ response, readPage, readOwned, input, authorize, signal }) {
  await authorize()
  let cursor, profiles = 0, connections = 0, observations = 0
  const line = async value => {
    signal?.throwIfAborted()
    if (!response.write(JSON.stringify(value) + '\n')) await once(response, 'drain', { signal })
  }
  // Resolve the first read before starting a successful attachment response.
  let page = input.scope === 'everyone' ? await readPage({ query: input.query, ids: input.ids, signal }) : null
  const owned = input.scope === 'mine' ? await readOwned({ signal }) : null
  const revision = page?.revision
  await authorize()
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="unlinked-network.jsonl"', 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex, nofollow, noarchive' })
  await line({ type: 'export', format: 'unlinked-visible-network', version: 1, exportedAt: new Date().toISOString(), ...input })
  if (owned) {
    const query = input.query.trim().toLowerCase(), selected = new Set(input.ids)
    for (const row of owned.assertions) {
      if (selected.size && !selected.has(row.id) && !selected.has(row.provenance?.toId)) continue
      if (query && !Object.values(row.fields ?? {}).some(value => typeof value === 'string' && value.toLowerCase().includes(query))) continue
      await line({ type: 'observation', observation: row }); observations++
    }
  }
  while (page) {
    await authorize()
    for (const profile of page.profiles) { await line({ type: 'profile', profile }); profiles++ }
    for (const connection of page.connections) { await line({ type: 'connection', ...connection }); connections++ }
    cursor = page.nextCursor
    page = cursor ? await readPage({ query: input.query, ids: input.ids, cursor, signal }) : null
  }
  await authorize()
  if (revision && (await readPage({ query: input.query, ids: input.ids, signal })).revision !== revision) throw Error('network_export_publication_changed')
  await line({ type: 'complete', profiles, connections, observations })
  response.end()
}
