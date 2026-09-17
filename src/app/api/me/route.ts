import { NextResponse } from "next/server";
import { authenticate, jsonError } from "@/utils/agent-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/me
 *
 * The caller's own profile plus connection / upload counts. The profile is
 * resolved from the authenticated user id, never from the request.
 */
export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { supabase, userId } = auth.caller;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(
      `
      id, user_id, full_name, headline, summary, industry, linkedin_slug,
      created_at, updated_at,
      positions:positions(id, title, description, started_on, finished_on, companies(name)),
      education:education(id, degree_name, started_on, finished_on, institutions(name)),
      skills:skills(id, name)
    `
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("/api/me profile lookup failed:", error);
    return jsonError(500, "profile lookup failed");
  }
  if (!profile) return jsonError(404, "no profile exists for this account");

  const profileId = profile.id as string;

  const [connections, uploads] = await Promise.all([
    supabase
      .from("connections")
      .select("id", { count: "exact", head: true })
      .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`),
    supabase
      .from("uploads")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
  ]);

  return NextResponse.json({
    profile,
    counts: {
      connections: connections.count ?? 0,
      uploads: uploads.count ?? 0,
    },
    auth: { via: auth.caller.via },
  });
}
