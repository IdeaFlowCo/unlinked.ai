import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createClient as createSupabaseJsClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/utils/supabase/server";

/**
 * Auth layer shared by every endpoint on the agent surface.
 *
 * A caller is resolved from EITHER:
 *   1. the normal Supabase session cookie (browser), or
 *   2. `Authorization: Bearer ul_<key>` (agent / MCP client).
 *
 * In both cases we end up with a Supabase client whose requests carry a JWT
 * for the resolved user, so Postgres RLS is the single enforcement point. The
 * bearer path mints a short-lived user JWT rather than handing the agent a
 * service-role client, so a bug in a route handler cannot escalate past the
 * policies that already protect the browser session.
 *
 * Client-supplied user / profile IDs are never trusted anywhere in this file.
 */

export const AGENT_KEY_PREFIX = "ul_";

/** Minted user JWTs are deliberately short-lived; they exist for one request. */
const AGENT_JWT_TTL_SECONDS = 15 * 60;

export type AuthVia = "session" | "agent-key";

export interface Caller {
  userId: string;
  supabase: SupabaseClient;
  via: AuthVia;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; response: NextResponse };

export function jsonError(
  status: number,
  error: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

// ---------------------------------------------------------------------------
// postgrest error shape helpers
// ---------------------------------------------------------------------------

interface PgLikeError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** True when the failure is "this table has not been created yet". */
export function isMissingTable(error: PgLikeError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return /could not find the table|relation .* does not exist/i.test(text);
}

/** True when the failure is "this column has not been added yet". */
export function isMissingColumn(error: PgLikeError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return /column .* does not exist|could not find the .* column/i.test(text);
}

// ---------------------------------------------------------------------------
// key material
// ---------------------------------------------------------------------------

/** Generate a fresh plaintext agent key. Shown to the user exactly once. */
export function generateAgentKey(): string {
  return AGENT_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** Deterministic lookup hash. Keys are high-entropy, so a plain sha256 is fine. */
export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ---------------------------------------------------------------------------
// JWT minting (HS256, Supabase-compatible)
// ---------------------------------------------------------------------------

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function mintUserJwt(userId: string, supabaseUrl: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256Jwt(
    {
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      iss: `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`,
      iat: now,
      exp: now + AGENT_JWT_TTL_SECONDS,
      is_anonymous: false,
    },
    secret
  );
}

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------

interface ServiceEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
}

function readServiceEnv(): ServiceEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!url || !anonKey || !serviceRoleKey || !jwtSecret) return null;
  return { url, anonKey, serviceRoleKey, jwtSecret };
}

/**
 * Service-role client, constructed lazily at request time. Bypasses RLS --
 * only use it for the agent-key lookup and for the cron embedding job.
 */
export function createServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createSupabaseJsClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function createUserScopedClient(env: ServiceEnv, jwt: string): SupabaseClient {
  return createSupabaseJsClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Constant-time compare of two equal-length ascii/hex strings. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Constant-time compare of two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  return constantTimeEquals(a, b);
}

async function authenticateAgentKey(key: string): Promise<AuthResult> {
  const env = readServiceEnv();
  if (!env) {
    return {
      ok: false,
      response: jsonError(
        503,
        "agent key auth is not configured on this deployment",
        {
          hint: "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_JWT_SECRET must be set",
        }
      ),
    };
  }

  const service = createSupabaseJsClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const keyHash = hashAgentKey(key);
  const { data, error } = await service
    .from("agent_keys")
    .select("id, user_id, key_hash")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return {
        ok: false,
        response: jsonError(503, "agent keys not yet enabled", {
          hint: "the agent_surface migration has not been applied to this database",
        }),
      };
    }
    console.error("agent key lookup failed:", error);
    return { ok: false, response: jsonError(500, "agent key lookup failed") };
  }

  if (!data || !hashesMatch(String(data.key_hash), keyHash)) {
    return { ok: false, response: jsonError(401, "invalid or revoked api key") };
  }

  // Best effort; a failed touch must not fail the request.
  void service
    .from("agent_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: touchError }) => {
      if (touchError) console.error("agent key touch failed:", touchError);
    });

  const userId = String(data.user_id);
  const jwt = mintUserJwt(userId, env.url, env.jwtSecret);

  return {
    ok: true,
    caller: { userId, supabase: createUserScopedClient(env, jwt), via: "agent-key" },
  };
}

async function authenticateSession(): Promise<AuthResult> {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return {
      ok: false,
      response: jsonError(503, "supabase is not configured on this deployment"),
    };
  }

  const supabase = await createSessionClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { ok: false, response: jsonError(401, "not authenticated") };
  }

  return { ok: true, caller: { userId: user.id, supabase, via: "session" } };
}

export interface AuthenticateOptions {
  /** Set false for endpoints that must only ever be reached from the browser. */
  allowAgentKey?: boolean;
}

/**
 * Resolve the caller from a session cookie or an `ul_` bearer token.
 * Returns a ready-to-use, RLS-scoped Supabase client on success.
 */
export async function authenticate(
  request: Request,
  options: AuthenticateOptions = {}
): Promise<AuthResult> {
  const { allowAgentKey = true } = options;
  const bearer = extractBearer(request);

  if (bearer && bearer.startsWith(AGENT_KEY_PREFIX)) {
    if (!allowAgentKey) {
      return {
        ok: false,
        response: jsonError(401, "this endpoint requires a signed-in session"),
      };
    }
    return authenticateAgentKey(bearer);
  }

  return authenticateSession();
}

// ---------------------------------------------------------------------------
// profile resolution
// ---------------------------------------------------------------------------

export interface CallerProfile {
  id: string;
  full_name: string | null;
  headline: string | null;
  industry: string | null;
}

/**
 * The caller's own profile row, derived server-side from their user id.
 * Never accept a profile id from the request body for this purpose.
 */
export async function resolveCallerProfile(
  caller: Caller
): Promise<{ ok: true; profile: CallerProfile } | { ok: false; response: NextResponse }> {
  const { data, error } = await caller.supabase
    .from("profiles")
    .select("id, full_name, headline, industry")
    .eq("user_id", caller.userId)
    .maybeSingle();

  if (error) {
    console.error("caller profile lookup failed:", error);
    return { ok: false, response: jsonError(500, "profile lookup failed") };
  }
  if (!data) {
    return {
      ok: false,
      response: jsonError(404, "no profile exists for this account"),
    };
  }

  return { ok: true, profile: data as CallerProfile };
}

/** Profile ids of everyone directly connected to `profileId`. */
export async function getConnectedProfileIds(
  caller: Caller,
  profileId: string
): Promise<{ ok: true; ids: string[] } | { ok: false; response: NextResponse }> {
  const { data, error } = await caller.supabase
    .from("connections")
    .select("profile_id_a, profile_id_b")
    .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`);

  if (error) {
    console.error("connection lookup failed:", error);
    return { ok: false, response: jsonError(500, "connection lookup failed") };
  }

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const a = row.profile_id_a as string | null;
    const b = row.profile_id_b as string | null;
    const other = a === profileId ? b : a;
    if (other && other !== profileId) ids.add(other);
  }

  return { ok: true, ids: Array.from(ids) };
}

/** True when `otherProfileId` is a direct connection of `profileId`. */
export async function isDirectConnection(
  caller: Caller,
  profileId: string,
  otherProfileId: string
): Promise<boolean> {
  const [a, b] =
    profileId < otherProfileId
      ? [profileId, otherProfileId]
      : [otherProfileId, profileId];

  const { data, error } = await caller.supabase
    .from("connections")
    .select("id")
    .eq("profile_id_a", a)
    .eq("profile_id_b", b)
    .maybeSingle();

  if (error) {
    console.error("connection check failed:", error);
    return false;
  }
  return Boolean(data);
}
