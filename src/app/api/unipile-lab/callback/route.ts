import { NextResponse } from 'next/server'
import { LabError } from '@/utils/unipile-lab'
import { lab, labEnabled } from '@/utils/unipile-lab-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Unipile v1 notify_url webhook. Redirects are never accepted as proof. */
export async function POST(request: Request) {
  if (!labEnabled()) return new NextResponse(null, { status: 404 })
  const url = new URL(request.url)
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return new NextResponse(null, { status: 400 }) }
  try {
    await lab().callback({
      state: url.searchParams.get('state'),
      token: url.searchParams.get('token'),
      name: body.name,
      status: body.status,
      accountId: body.account_id,
    })
    return NextResponse.json({ received: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    // Do not echo body, token, account ID, or raw provider failure.
    const status = error instanceof LabError && error.code === 'denied' ? 403 : 400
    return new NextResponse(null, { status })
  }
}
