// How large the shared public People index may grow. Every reader, builder and
// search shares these bounds: one stale copy makes the whole directory unavailable.
// The recovered legacy profiles alone are about 16,000, and member uploads add
// thousands each, so the bounds leave room to grow well past both.
export const PUBLIC_INDEX_MAX_PROFILES = 100000
export const PUBLIC_INDEX_MAX_CONNECTIONS = 500000
