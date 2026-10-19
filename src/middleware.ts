import { type NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'
import { runMiddlewareGate } from '@/utils/middleware-gate.mjs'

export async function middleware(request: NextRequest) {
    return await runMiddlewareGate(request, { nextResponse: NextResponse, updateSession })
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - apple-app-site-association (static, fetched by Apple without cookies)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|\\.well-known/apple-app-site-association$|apple-app-site-association$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}
