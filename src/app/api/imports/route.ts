import { NextResponse } from "next/server";
import { authenticate, jsonError, resolveCallerProfile } from "@/utils/agent-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/imports
 *
 * The caller's LinkedIn archive uploads plus counts of what has been ingested
 * into their graph.
 *
 * Caveat: the schema records no per-upload provenance (nothing links a
 * `connections` / `positions` / `education` / `skills` row back to the upload
 * that produced it), so `ingested` is an account-wide total rather than a
 * per-file breakdown.
 */
export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const self = await resolveCallerProfile(auth.caller);
  if (!self.ok) return self.response;

  const profileId = self.profile.id;
  const { supabase } = auth.caller;

  const { data: uploads, error } = await supabase
    .from("uploads")
    .select("id, file_name, file_path, created_at")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("/api/imports upload lookup failed:", error);
    return jsonError(500, "upload lookup failed");
  }

  const [connections, positions, education, skills] = await Promise.all([
    supabase
      .from("connections")
      .select("id", { count: "exact", head: true })
      .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`),
    supabase
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabase
      .from("education")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabase
      .from("skills")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
  ]);

  return NextResponse.json({
    uploads: uploads ?? [],
    ingested: {
      connections: connections.count ?? 0,
      positions: positions.count ?? 0,
      education: education.count ?? 0,
      skills: skills.count ?? 0,
    },
    note: "ingested counts are account-wide; the schema records no per-upload provenance",
  });
}
