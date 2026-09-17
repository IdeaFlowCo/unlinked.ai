import { NextResponse } from "next/server";
import { authenticate, isMissingTable, jsonError } from "@/utils/agent-auth";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revoke an agent key. Session auth only; RLS restricts this to the owner. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(request, { allowAgentKey: false });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(400, "invalid key id");

  const { data, error } = await auth.caller.supabase
    .from("agent_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", auth.caller.userId)
    .is("revoked_at", null)
    .select("id, name, created_at, last_used_at, revoked_at")
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return jsonError(503, "agent keys not yet enabled");
    }
    console.error("agent key revoke failed:", error);
    return jsonError(500, "failed to revoke agent key");
  }

  if (!data) return jsonError(404, "key not found or already revoked");

  return NextResponse.json(data);
}
