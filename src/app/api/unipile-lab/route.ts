import { NextResponse } from 'next/server'
import { LabError } from '@/utils/unipile-lab'
import { callbackOrigin, lab, labMode, sameOrigin, testerId } from '@/utils/unipile-lab-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

function failure(error: unknown) {
  if (!(error instanceof LabError)) return json({ error: 'Preview unavailable.' }, 503)
  const status = error.code === 'invalid' ? 400 : error.code === 'denied' ? 403 : error.code === 'conflict' ? 409 : error.code === 'expired' ? 410 : error.code === 'unsupported' ? 422 : 503
  return json({ outcome: error.code, error: error.message }, status)
}

export async function GET() {
  const userId = await testerId()
  if (!userId) return json({ error: 'Not found.' }, 404)
  try { return json({ ...lab().get(userId), mode: labMode() }) } catch (error) { return failure(error) }
}

export async function POST(request: Request) {
  const userId = await testerId()
  if (!userId) return json({ error: 'Not found.' }, 404)
  if (!sameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403)
  let body: { action?: unknown; url?: unknown }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON.' }, 400) }
  try {
    const instance = lab()
    switch (body.action) {
      case 'connect': return json({ ...await instance.start(userId, callbackOrigin(request)), mode: labMode() })
      case 'reconnect': return json({ ...await instance.start(userId, callbackOrigin(request), true), mode: labMode() })
      case 'own-connections': return json({ preview: await instance.ownConnections(userId) })
      case 'preview-target': return json({ preview: await instance.previewTarget(userId, body.url) })
      case 'target-connections': return json({ preview: await instance.targetConnections(userId) })
      case 'reset': instance.reset(userId); return json({ preview: null })
      default: return json({ error: 'Unknown action.' }, 400)
    }
  } catch (error) { return failure(error) }
}
