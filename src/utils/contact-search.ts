import { NextResponse } from "next/server";
import {
  getConnectedProfileIds,
  jsonError,
  resolveCallerProfile,
  type Caller,
} from "@/utils/agent-auth";
import { CHAT_MODEL, getOpenAI, MissingEnvError, semanticSearch } from "@/utils/ai-search";

/**
 * Scoped contact search: semantic search restricted to the caller's own direct
 * connections, then an LLM pass that drops irrelevant hits and explains the
 * survivors.
 *
 * The caller's profile is always derived server-side from their user id. No
 * request ever supplies the profile whose network is searched.
 */

export const MAX_CONTACT_SEARCH_LIMIT = 25;
const DEFAULT_LIMIT = 10;

export interface ContactSearchProfile {
  id: string;
  full_name: string | null;
  headline: string | null;
  industry: string | null;
}

export interface ContactSearchHit {
  profile: ContactSearchProfile;
  score: number;
  reason: string;
}

export interface ContactSearchSuccess {
  ok: true;
  selfProfileId: string;
  results: ContactSearchHit[];
}

export type ContactSearchOutcome =
  | ContactSearchSuccess
  | { ok: false; response: NextResponse };

export function normalizeLimit(raw: unknown): number {
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_CONTACT_SEARCH_LIMIT);
}

interface RerankVerdict {
  id: string;
  relevant: boolean;
  reason: string;
}

async function rerank(
  query: string,
  candidates: ContactSearchProfile[]
): Promise<Map<string, RerankVerdict>> {
  const verdicts = new Map<string, RerankVerdict>();

  const openai = getOpenAI();
  const roster = candidates
    .map((profile) =>
      [
        `id: ${profile.id}`,
        `name: ${profile.full_name ?? "unknown"}`,
        `headline: ${profile.headline ?? "none"}`,
        `industry: ${profile.industry ?? "none"}`,
      ].join(" | ")
    )
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You screen a person's professional contacts against a search request. " +
          "Keep only contacts who plausibly match the request; drop clearly " +
          "irrelevant ones. Be decisive: an empty result is better than a bad one. " +
          'Respond with JSON of the form {"results":[{"id":"<contact id>",' +
          '"relevant":true,"reason":"one sentence on why this contact matches"}]}. ' +
          "Use only ids from the provided list. Keep each reason to one sentence.",
      },
      {
        role: "user",
        content: `Search request: ${query}\n\nContacts:\n${roster}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return verdicts;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("contact search rerank returned non-json");
    return verdicts;
  }

  const rows = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return verdicts;

  for (const row of rows) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id !== "string") continue;
    const relevant = (row as { relevant?: unknown })?.relevant !== false;
    const reason = (row as { reason?: unknown })?.reason;
    verdicts.set(id, {
      id,
      relevant,
      reason: typeof reason === "string" ? reason.trim() : "",
    });
  }

  return verdicts;
}

export async function searchContacts(
  caller: Caller,
  query: string,
  limit: number
): Promise<ContactSearchOutcome> {
  const profileResult = await resolveCallerProfile(caller);
  if (!profileResult.ok) return profileResult;
  const selfProfileId = profileResult.profile.id;

  const connectionResult = await getConnectedProfileIds(caller, selfProfileId);
  if (!connectionResult.ok) return connectionResult;

  if (connectionResult.ids.length === 0) {
    return { ok: true, selfProfileId, results: [] };
  }

  const candidateCount = Math.min(Math.max(limit * 3, 10), 60);

  let matches;
  try {
    matches = await semanticSearch(query, candidateCount, connectionResult.ids);
  } catch (error) {
    if (error instanceof MissingEnvError) {
      return {
        ok: false,
        response: jsonError(503, "semantic search is not configured", {
          hint: `${error.varName} is not set on this deployment`,
        }),
      };
    }
    console.error("semantic search failed:", error);
    return { ok: false, response: jsonError(502, "semantic search failed") };
  }

  if (matches.length === 0) {
    return { ok: true, selfProfileId, results: [] };
  }

  const scoreByProfileId = new Map<string, number>();
  for (const match of matches) {
    const profileId = match.metadata?.profileId;
    if (profileId) scoreByProfileId.set(profileId, match.score);
  }

  const { data: profileRows, error: profileError } = await caller.supabase
    .from("profiles")
    .select("id, full_name, headline, industry")
    .in("id", Array.from(scoreByProfileId.keys()));

  if (profileError) {
    console.error("profile hydration failed:", profileError);
    return { ok: false, response: jsonError(500, "profile lookup failed") };
  }

  const candidates = ((profileRows ?? []) as ContactSearchProfile[]).sort(
    (a, b) => (scoreByProfileId.get(b.id) ?? 0) - (scoreByProfileId.get(a.id) ?? 0)
  );

  if (candidates.length === 0) {
    return { ok: true, selfProfileId, results: [] };
  }

  // The LLM pass is a quality filter, not a security boundary. If it fails we
  // degrade to raw vector ranking rather than failing the request.
  let verdicts = new Map<string, RerankVerdict>();
  try {
    verdicts = await rerank(query, candidates);
  } catch (error) {
    if (!(error instanceof MissingEnvError)) {
      console.error("contact search rerank failed:", error);
    }
  }

  const results: ContactSearchHit[] = [];
  for (const profile of candidates) {
    const verdict = verdicts.get(profile.id);
    if (verdicts.size > 0) {
      if (!verdict || !verdict.relevant) continue;
    }
    results.push({
      profile,
      score: scoreByProfileId.get(profile.id) ?? 0,
      reason: verdict?.reason ?? "",
    });
    if (results.length >= limit) break;
  }

  return { ok: true, selfProfileId, results };
}
