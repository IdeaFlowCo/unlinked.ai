import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'

export async function middleware(request: NextRequest) {
    const res = await updateSession(request)

    // Get the pathname from the URL
    const pathname = request.nextUrl.pathname

    // Check if we're on a protected route
    const isProtectedRoute = pathname.startsWith('/profiles')
    const isAuthRoute = pathname.startsWith('/login')

    // Get session from response headers
    const hasSession = res.headers.get('x-supabase-auth') === 'authenticated'

    if (!hasSession && isProtectedRoute) {
        // Redirect to login if accessing protected route without session
        const redirectUrl = new URL('/login', request.url)
        return NextResponse.redirect(redirectUrl)
    }

    if (hasSession && isAuthRoute) {
        // Redirect to profiles if accessing auth route with session
        const redirectUrl = new URL('/profiles', request.url)
        return NextResponse.redirect(redirectUrl)
    }

    return res
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}
