// The offline operator scripts (publishers, claim and storage operators) connect to
// the same private graph as the runtime. Mirror deploy/private-pilot/runtime.mjs:
// the graph host follows PILOT_NETWORK_MODE from a fixed allow-list, never an
// arbitrary URL. Since the shared-noos cutover (unlinked-s21-20261007) the graph is
// noos_neo4j; the old `graph` container no longer exists. Operators predate the
// network modes, so an unset mode keeps their original isolated-container host.
const HOSTS = { 'shared-noos': 'bolt://noos_neo4j:7687', 'isolated-container': 'bolt://graph:7687', loopback: 'bolt://127.0.0.1:9289' }

export function operatorBoltUrl(env = process.env) {
  const url = HOSTS[env.PILOT_NETWORK_MODE ?? 'isolated-container']
  if (!url) throw new Error('operator_network_mode_invalid')
  if (env.PILOT_BOLT_URL !== undefined && env.PILOT_BOLT_URL !== url) throw new Error('operator_bolt_url_mismatch')
  return url
}
