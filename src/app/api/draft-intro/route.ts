import { NextResponse } from "next/server";
import {
  authenticate,
  isDirectConnection,
  jsonError,
  resolveCallerProfile,
} from "@/utils/agent-auth";
import { CHAT_MODEL, getOpenAI, MissingEnvError } from "@/utils/ai-search";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROFILE_FIELDS = `
  id, full_name, headline, summary, industry,
  positions:positions(title, description, started_on, finished_on, companies(name)),
  education:education(degree_name, institutions(name)),
  skills:skills(name)
`;

interface ProfileSketch {
  full_name?: string | null;
  headline?: string | null;
  summary?: string | null;
  industry?: string | null;
  positions?: Array<{
    title?: string | null;
    started_on?: string | null;
    finished_on?: string | null;
    companies?: { name?: string | null } | null;
  }> | null;
  education?: Array<{
    degree_name?: string | null;
    institutions?: { name?: string | null } | null;
  }> | null;
  skills?: Array<{ name?: string | null }> | null;
}

function describe(profile: ProfileSketch): string {
  const lines: string[] = [];
  lines.push(`name: ${profile.full_name ?? "unknown"}`);
  if (profile.headline) lines.push(`headline: ${profile.headline}`);
  if (profile.industry) lines.push(`industry: ${profile.industry}`);
  if (profile.summary) lines.push(`summary: ${profile.summary.slice(0, 800)}`);

  const roles = (profile.positions ?? [])
    .slice(0, 6)
    .map((position) => {
      const company = position.companies?.name ?? "unknown company";
      const dates = [position.started_on, position.finished_on]
        .filter(Boolean)
        .join(" - ");
      return `${position.title ?? "role"} at ${company}${dates ? ` (${dates})` : ""}`;
    })
    .join("; ");
  if (roles) lines.push(`roles: ${roles}`);

  const schools = (profile.education ?? [])
    .slice(0, 4)
    .map(
      (entry) =>
        `${entry.degree_name ?? "studied"} at ${entry.institutions?.name ?? "unknown"}`
    )
    .join("; ");
  if (schools) lines.push(`education: ${schools}`);

  const skills = (profile.skills ?? [])
    .slice(0, 20)
    .map((skill) => skill.name)
    .filter(Boolean)
    .join(", ");
  if (skills) lines.push(`skills: ${skills}`);

  return lines.join("\n");
}

/**
 * POST /api/draft-intro
 *
 * Body: { contactProfileId: string, context?: string }
 *
 * Drafts a short, forwardable intro between the caller and one of their direct
 * connections. Read-only: nothing is written to the database.
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

  const contactProfileId = (body as { contactProfileId?: unknown } | null)
    ?.contactProfileId;
  if (typeof contactProfileId !== "string" || !UUID_RE.test(contactProfileId)) {
    return jsonError(400, "contactProfileId must be a profile uuid");
  }

  const rawContext = (body as { context?: unknown } | null)?.context;
  const context =
    typeof rawContext === "string" ? rawContext.trim().slice(0, 2000) : "";

  const self = await resolveCallerProfile(auth.caller);
  if (!self.ok) return self.response;

  if (contactProfileId === self.profile.id) {
    return jsonError(400, "contactProfileId must be someone other than you");
  }

  const connected = await isDirectConnection(
    auth.caller,
    self.profile.id,
    contactProfileId
  );
  if (!connected) {
    return jsonError(404, "profile not found");
  }

  const { data: profiles, error } = await auth.caller.supabase
    .from("profiles")
    .select(PROFILE_FIELDS)
    .in("id", [self.profile.id, contactProfileId]);

  if (error) {
    console.error("/api/draft-intro profile lookup failed:", error);
    return jsonError(500, "profile lookup failed");
  }

  const rows = (profiles ?? []) as Array<ProfileSketch & { id: string }>;
  const me = rows.find((row) => row.id === self.profile.id);
  const contact = rows.find((row) => row.id === contactProfileId);
  if (!me || !contact) return jsonError(404, "profile not found");

  let draft: string;
  try {
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "You draft short, forwardable intro messages between two professionals " +
            "who already know each other. Write in the first person as the sender. " +
            "Keep it under 120 words, warm but not fawning, concrete about why the " +
            "two should talk, and easy to forward. No subject line, no placeholders " +
            "like [name], no markdown. Use only facts given to you.",
        },
        {
          role: "user",
          content:
            `Sender (me):\n${describe(me)}\n\n` +
            `Recipient (my contact):\n${describe(contact)}\n\n` +
            (context
              ? `What I want out of this intro: ${context}`
              : "No extra context was given; write a general reconnect-and-explore note."),
        },
      ],
    });
    draft = completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (caught) {
    if (caught instanceof MissingEnvError) {
      return jsonError(503, "intro drafting is not configured", {
        hint: `${caught.varName} is not set on this deployment`,
      });
    }
    console.error("/api/draft-intro generation failed:", caught);
    return jsonError(502, "intro drafting failed");
  }

  if (!draft) return jsonError(502, "intro drafting returned nothing");

  return NextResponse.json({
    draft,
    contact: {
      id: contactProfileId,
      full_name: contact.full_name ?? null,
      headline: contact.headline ?? null,
    },
  });
}
