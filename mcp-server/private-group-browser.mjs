import { randomUUID } from 'node:crypto'
import { renderGroupError } from './collective-group-views.mjs'
import { renderPrivateGroup, rosterImportForm, rosterPreview, rosterRows, pilotEnableForm } from './private-group-views.mjs'
const UUID = '[0-9a-f-]{36}'
export const isPrivateGroupPilotPath = path => /^\/groups\/[^/]+\/(?:private(?:\/enable)?|roster(?:\/(?:preview|commit|draft|resolve|clear))?)$/.test(path)
const matchPath = new RegExp(`^/groups/(${UUID})/(private(?:/enable)?|roster(?:/(?:preview|commit|draft|resolve|clear))?)$`)

export function createPrivateGroupBrowser({ pilot, body, now = Date.now }) {
  // Ephemeral owner/session-bound previews: never store uploaded bytes, and
  // never trust hidden rows/digests returned by the browser. Restart expires it.
  const reviews = new Map()
  return {
    async navigation(actor, id, chrome) {
      if (!pilot) return ''
      try { const group = await pilot.detail(actor, id); return group.owner ? `<p><a href="/groups/${id}/roster">Your private pending roster</a></p>` : '' } catch {
        return await pilot.available(actor, id) ? pilotEnableForm(chrome, id) : ''
      }
    },
    matches: path => matchPath.test(path),
    async handle({ request, url, session, render, redirect, readCandidates, lookupCandidates }) {
      const m = matchPath.exec(url.pathname), id = m?.[1], action = m?.[2]
      const chrome = { csrf: session?.csrf, displayName: session?.displayName, accountLabel: session?.accountLabel }
      try {
        if (!pilot || !session || !m || !['GET', 'POST'].includes(request.method)) throw Error('not_found')
        for (const [key, review] of reviews) if (review.expires <= now()) reviews.delete(key)
        const actor = session.owner
        const fields = async names => {
          if (request.method !== 'POST' || request.headers.origin !== url.origin ||
            request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw Error('invalid_input')
          const input = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(await body(request, 7 * 1024 * 1024)))
          if (input.size !== names.length + 1 || input.getAll('csrf').length !== 1 || input.get('csrf') !== session.csrf || names.some(k => input.getAll(k).length !== 1)) throw Error('invalid_input')
          return input
        }
        if (action === 'private/enable') {
          await fields([])
          await pilot.enable(actor, id)
          return redirect(`/groups/${id}/roster`)
        }
        const group = await pilot.detail(actor, id)
        if (action === 'private' && request.method === 'GET') return render(renderPrivateGroup(chrome, group))
        if (!group.owner || !action.startsWith('roster')) throw Error('not_found')
        if (action === 'roster/preview') {
          const input = await fields(['format', 'roster'])
          const preview = await pilot.preview(actor, id, Buffer.from(input.get('roster')), input.get('format'))
          if (reviews.size >= 8) throw Error('preview_busy')
          const token = randomUUID()
          reviews.set(token, { actor: JSON.stringify(actor), csrf: session.csrf, id, preview, expires: now() + 10 * 60000 })
          return render(renderPrivateGroup(chrome, group, rosterPreview(chrome, id, preview, token)))
        }
        if (action === 'roster/commit') {
          const input = await fields(['review', 'ack']), review = reviews.get(input.get('review'))
          if (!review || review.actor !== JSON.stringify(actor) || review.csrf !== session.csrf || review.id !== id || review.expires <= now()) throw Error('review_changed')
          reviews.delete(input.get('review'))
          await pilot.commit(actor, id, review.preview, input.get('ack'))
          return redirect(`/groups/${id}/roster`)
        }
        if (action === 'roster/resolve') {
          await fields([])
          await pilot.resolveNext(actor, id, readCandidates, lookupCandidates)
          return redirect(`/groups/${id}/roster`)
        }
        if (action === 'roster/clear') {
          const input = await fields(['ack'])
          await pilot.clear(actor, id, input.get('ack'))
          return redirect(`/groups/${id}/roster`)
        }
        let draft
        if (action === 'roster/draft') {
          const input = await fields(['participant'])
          draft = await pilot.draft(actor, id, input.get('participant'))
        } else if (request.method !== 'GET' || action !== 'roster') throw Error('not_found')
        const offset = url.searchParams.get('offset') ?? '0'
        if (!/^\d{1,4}$/.test(offset)) throw Error('invalid_input')
        const rows = await pilot.suggestions(actor, id, readCandidates, Number(offset), lookupCandidates)
        return render(renderPrivateGroup(chrome, group, rosterRows(chrome, id, rows, draft) + rosterImportForm(chrome, id)))
      } catch (error) {
        const code = error.code ?? error.message
        const status = code === 'not_found' ? 404 : code === 'review_changed' ? 409 : ['invalid_input', 'invalid_roster', 'acknowledgement_required'].includes(code) ? 400 : 503
        return render(renderGroupError(chrome, status === 404 ? 'Group not found.' : status === 409 ? 'The group changed. Preview the roster again.' : status === 400 ? 'Check the prepared roster and required acknowledgement.' : 'Private group temporarily unavailable.'), status)
      }
    },
  }
}
