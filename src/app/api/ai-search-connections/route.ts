import { NextResponse } from "next/server";
import { authenticate, jsonError } from "@/utils/agent-auth";
import { normalizeLimit, searchContacts } from "@/utils/contact-search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * DEPRECATED. Use POST /api/search-contacts.
 *
 * Kept as a thin alias for older clients. The previous implementation trusted a
 * client-supplied `profileId` and would happily search any user's network; that
 * parameter is now ignored and the caller's own profile is resolved from their
 * session. Session auth only -- agents should call /api/search-contacts.
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, { allowAgentKey: false });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "body must be valid json");
  }

  const rawQuery = (body as { query?: unknown } | null)?.query;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) return jsonError(400, "query must be a non-empty string");

  const limit = normalizeLimit((body as { limit?: unknown } | null)?.limit);

  const outcome = await searchContacts(auth.caller, query, limit);
  if (!outcome.ok) return outcome.response;

  // Legacy response shape: connection-ish rows with the caller on side A.
  const connections = outcome.results.map((hit) => ({
    id: `${outcome.selfProfileId}:${hit.profile.id}`,
    profile_id_a: outcome.selfProfileId,
    profile_id_b: hit.profile.id,
    profile_a: { id: outcome.selfProfileId },
    profile_b: hit.profile,
    reason: hit.reason,
    score: hit.score,
  }));

  return NextResponse.json(
    { connections, deprecated: "use POST /api/search-contacts" },
    { headers: { Deprecation: "true", Link: '</api/search-contacts>; rel="successor-version"' } }
  );
}
