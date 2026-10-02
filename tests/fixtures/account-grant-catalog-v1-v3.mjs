// Immutable semantic snapshot of the main grant catalog before v4.
// Source: mcp-server/account-grants.mjs at 9405cbe86e0fa821ef13613c29043a6b2e667c85.
// Existing durable grants depend on these exact scope/tool lists; do not update
// this fixture when adding a new catalog version. Kept locally for shallow CI.
export const ACCOUNT_GRANT_TOOL_VERSIONS = Object.freeze({
  1: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone']),
  }),
  2: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search']),
  }),
  // Version 3 adds two read-only tools: the owner's pending connection
  // requests and their notification feed.
  3: Object.freeze({
    owner_network: Object.freeze(['unlinked_search_network', 'unlinked_whoami', 'unlinked_list_connections', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
    owner_network_and_public: Object.freeze(['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ai_search', 'unlinked_list_connection_requests', 'unlinked_list_notifications']),
  }),
})
