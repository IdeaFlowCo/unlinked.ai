import { NextResponse } from "next/server";
import {
  authenticate,
  isDirectConnection,
  jsonError,
  resolveCallerProfile,
} from "@/utils/agent-auth";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/profiles/[id]
 *
 * Readable only for the caller's own profile or a direct connection. Anything
 * else is a 404 -- not a 403 -- so the endpoint does not confirm whether an
 * unrelated profile exists.
 *
 * (Note: the `profiles` table itself is world-readable via RLS for the browser
 * app. This endpoint is deliberately narrower so agent keys get a
 * network-scoped view rather than the whole directory.)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(404, "profile not found");

  const self = await resolveCallerProfile(auth.caller);
  if (!self.ok) return self.response;

  if (id !== self.profile.id) {
    const connected = await isDirectConnection(auth.caller, self.profile.id, id);
    if (!connected) return jsonError(404, "profile not found");
  }

  const { data: profile, error } = await auth.caller.supabase
    .from("profiles")
    .select(
      `
      id, full_name, headline, summary, industry, linkedin_slug, created_at,
      positions:positions(id, title, description, started_on, finished_on, companies(name)),
      education:education(id, degree_name, started_on, finished_on, institutions(name)),
      skills:skills(id, name)
    `
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("/api/profiles/[id] lookup failed:", error);
    return jsonError(500, "profile lookup failed");
  }
  if (!profile) return jsonError(404, "profile not found");

  return NextResponse.json({
    profile,
    relationship: id === self.profile.id ? "self" : "direct-connection",
  });
}
