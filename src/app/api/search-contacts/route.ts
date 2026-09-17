import { NextResponse } from "next/server";
import { authenticate, jsonError } from "@/utils/agent-auth";
import { normalizeLimit, searchContacts } from "@/utils/contact-search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/search-contacts
 *
 * Body: { query: string, limit?: number (<= 25) }
 * Auth: session cookie or `Authorization: Bearer ul_<key>`
 *
 * Searches only the caller's own direct connections. The searched network is
 * derived from the authenticated user; nothing in the request selects it.
 */
export async function POST(request: Request) {
  const auth = await authenticate(request);
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
  if (query.length > 1000) {
    return jsonError(400, "query must be 1000 characters or fewer");
  }

  const limit = normalizeLimit((body as { limit?: unknown } | null)?.limit);

  const outcome = await searchContacts(auth.caller, query, limit);
  if (!outcome.ok) return outcome.response;

  return NextResponse.json({ results: outcome.results });
}
