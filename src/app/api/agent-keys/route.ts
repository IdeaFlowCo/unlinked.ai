import { NextResponse } from "next/server";
import {
  authenticate,
  generateAgentKey,
  hashAgentKey,
  isMissingTable,
  jsonError,
} from "@/utils/agent-auth";

export const dynamic = "force-dynamic";

/**
 * Agent key management. Session auth only -- an agent key may not mint another
 * agent key, so a leaked key cannot be used to establish persistence.
 */

export async function GET(request: Request) {
  const auth = await authenticate(request, { allowAgentKey: false });
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.caller.supabase
    .from("agent_keys")
    .select("id, name, created_at, last_used_at, revoked_at")
    .eq("user_id", auth.caller.userId)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) {
      return jsonError(503, "agent keys not yet enabled");
    }
    console.error("agent key list failed:", error);
    return jsonError(500, "failed to list agent keys");
  }

  return NextResponse.json({ keys: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await authenticate(request, { allowAgentKey: false });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "body must be valid json");
  }

  const rawName = (body as { name?: unknown } | null)?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return jsonError(400, "name must be a non-empty string");
  if (name.length > 100) return jsonError(400, "name must be 100 characters or fewer");

  const key = generateAgentKey();

  const { data, error } = await auth.caller.supabase
    .from("agent_keys")
    .insert({
      user_id: auth.caller.userId,
      name,
      key_hash: hashAgentKey(key),
    })
    .select("id, name, created_at, last_used_at, revoked_at")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return jsonError(503, "agent keys not yet enabled");
    }
    console.error("agent key create failed:", error);
    return jsonError(500, "failed to create agent key");
  }

  // `key` is returned exactly once and is not recoverable afterwards.
  return NextResponse.json({ ...data, key }, { status: 201 });
}
