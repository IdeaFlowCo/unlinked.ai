// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
    // Check for authentication cookie
    const hasAuthCookie = request.cookies.has('sb-access-token') || request.cookies.has('sb-refresh-token');

    // Redirect to auth if not authenticated
    if (!hasAuthCookie && request.nextUrl.pathname !== '/auth') {
        return NextResponse.redirect(new URL('/auth', request.url));
    }

    // Redirect root to auth
    if (request.nextUrl.pathname === '/') {
        return NextResponse.redirect(new URL('/auth', request.url));
    }
}

export const config = {
    matcher: ['/', '/onboarding', '/profile']
}
