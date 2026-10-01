// Structured download for one approved scoped grant. No credential in the URL.
// Real provider consent/registration and production setup remain explicit gates.
export function scopedSetupConfiguration({ endpoint, accessToken, allowLoopbackStaging = false }) {
  const url = new URL(endpoint)
  if ((url.protocol !== 'https:' && !(allowLoopbackStaging && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash || typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(accessToken)) throw new Error('scoped_https_setup_required')
  return { mcpServers: { 'unlinked-private': { url: url.toString(), headers: { Authorization: `Bearer ${accessToken}` } } } }
}

