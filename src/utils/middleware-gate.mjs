const backendIndependentPaths = new Set([
  '/',
  '/meet',
  '/meet/',
  '/import-linkedin',
  '/import-linkedin/',
])

const backendIndependentReadPaths = new Set([
  '/network',
  '/network/',
  '/search',
  '/search/',
  '/agents',
  '/agents/',
  '/auth/login',
  '/auth/login/',
  '/auth/signup',
  '/auth/signup/',
  '/auth/callback/ideaflow',
])

export function bypassesLegacySession(method, pathname) {
  if (backendIndependentPaths.has(pathname)) return true
  return ['GET', 'HEAD'].includes(method) && backendIndependentReadPaths.has(pathname)
}

export async function runMiddlewareGate(request, { nextResponse, updateSession }) {
  if (bypassesLegacySession(request.method, request.nextUrl.pathname)) {
    return nextResponse.next()
  }
  return await updateSession(request)
}
