import { NextResponse } from "next/server";
import {
  constantTimeEquals,
  createServiceRoleClient,
  extractBearer,
  isMissingColumn,
  jsonError,
} from "@/utils/agent-auth";
import { embedTexts, getPineconeIndex, MissingEnvError } from "@/utils/ai-search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET/POST /api/cron/embed
 *
 * Pulls a batch of profiles with no embedding yet, embeds them, and upserts
 * them into Pinecone. Intended to be invoked by Vercel Cron (see
 * vercel.json); also callable manually for backfills.
 *
 * Guarded by `Authorization: Bearer ${CRON_SECRET}`. If CRON_SECRET is not
 * set, the endpoint fails closed with 503 rather than running unauthenticated
 * -- there is no "open" mode.
 */

const BATCH_SIZE = 100;
const EMBED_CHUNK_SIZE = 20;

const PROFILE_FIELDS = `
  id, full_name, headline, summary, industry,
  positions:positions(title, companies(name)),
  education:education(degree_name, institutions(name)),
  skills:skills(name)
`;

interface ProfileRow {
  id: string;
  full_name?: string | null;
  headline?: string | null;
  summary?: string | null;
  industry?: string | null;
  positions?: Array<{
    title?: string | null;
    companies?: { name?: string | null } | null;
  }> | null;
  education?: Array<{
    degree_name?: string | null;
    institutions?: { name?: string | null } | null;
  }> | null;
  skills?: Array<{ name?: string | null }> | null;
}

function buildEmbeddingText(profile: ProfileRow): string {
  const lines: string[] = [];
  if (profile.full_name) lines.push(profile.full_name);
  if (profile.headline) lines.push(profile.headline);
  if (profile.industry) lines.push(profile.industry);
  if (profile.summary) lines.push(profile.summary.slice(0, 2000));

  const roles = (profile.positions ?? [])
    .map((p) => [p.title, p.companies?.name].filter(Boolean).join(" at "))
    .filter(Boolean)
    .join("; ");
  if (roles) lines.push(roles);

  const schools = (profile.education ?? [])
    .map((e) => [e.degree_name, e.institutions?.name].filter(Boolean).join(" at "))
    .filter(Boolean)
    .join("; ");
  if (schools) lines.push(schools);

  const skills = (profile.skills ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .join(", ");
  if (skills) lines.push(skills);

  return lines.join("\n").trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function authorizeCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return jsonError(503, "cron endpoint is not configured", {
      hint: "CRON_SECRET is not set on this deployment",
    });
  }

  const provided = extractBearer(request);
  if (!provided || !constantTimeEquals(provided, secret)) {
    return jsonError(401, "unauthorized");
  }

  return null;
}

async function runEmbedBatch(): Promise<NextResponse> {
  const supabase = createServiceRoleClient();
  if (!supabase) {
    return jsonError(503, "embedding job is not configured", {
      hint: "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing",
    });
  }

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select(PROFILE_FIELDS)
    .is("embedded_at", null)
    .limit(BATCH_SIZE);

  if (error) {
    if (isMissingColumn(error)) {
      return jsonError(503, "embedding job is not enabled", {
        hint: "the agent_surface migration has not been applied to this database",
      });
    }
    console.error("/api/cron/embed profile fetch failed:", error);
    return jsonError(500, "profile fetch failed");
  }

  const rows = (profiles ?? []) as unknown as ProfileRow[];
  if (rows.length === 0) {
    return NextResponse.json({ fetched: 0, embedded: 0, skipped: 0 });
  }

  const withText = rows.map((row) => ({ row, text: buildEmbeddingText(row) }));
  const embeddable = withText.filter((w) => w.text.length > 0);
  const empty = withText.filter((w) => w.text.length === 0);

  let embeddedCount = 0;
  const errors: string[] = [];

  try {
    const index = getPineconeIndex();

    for (const batch of chunk(embeddable, EMBED_CHUNK_SIZE)) {
      const vectors = await embedTexts(batch.map((b) => b.text));

      await index.upsert(
        batch.map((b, i) => {
          const metadata: Record<string, string> = { profileId: b.row.id };
          if (b.row.headline) metadata.headline = b.row.headline;
          return { id: b.row.id, values: vectors[i], metadata };
        })
      );

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ embedded_at: new Date().toISOString() })
        .in(
          "id",
          batch.map((b) => b.row.id)
        );

      if (updateError) {
        console.error("/api/cron/embed embedded_at update failed:", updateError);
        errors.push(updateError.message);
        continue;
      }

      embeddedCount += batch.length;
    }
  } catch (caught) {
    if (caught instanceof MissingEnvError) {
      return jsonError(503, "embedding job is not configured", {
        hint: `${caught.varName} is not set on this deployment`,
      });
    }
    console.error("/api/cron/embed embedding failed:", caught);
    return jsonError(502, "embedding failed", { embedded: embeddedCount });
  }

  // Profiles with nothing to embed (no name/headline/summary/etc.) are
  // stamped as embedded too, so the batch doesn't retry them forever.
  if (empty.length > 0) {
    const { error: skipError } = await supabase
      .from("profiles")
      .update({ embedded_at: new Date().toISOString() })
      .in(
        "id",
        empty.map((e) => e.row.id)
      );
    if (skipError) {
      console.error("/api/cron/embed skip-stamp failed:", skipError);
    }
  }

  return NextResponse.json({
    fetched: rows.length,
    embedded: embeddedCount,
    skipped: empty.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  return runEmbedBatch();
}

export async function POST(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;
  return runEmbedBatch();
}
