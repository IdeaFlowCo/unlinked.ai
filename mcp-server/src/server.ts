/**
 * Shared server-construction logic for the unlinked.ai MCP server.
 *
 * Tools registered:
 *   unlinked_me               — the caller's own profile + counts
 *   unlinked_search_contacts  — semantic search over the caller's direct connections
 *   unlinked_get_profile      — read a profile (self or direct connection only)
 *   unlinked_list_imports     — the caller's LinkedIn archive uploads
 *   unlinked_draft_intro      — draft a forwardable intro to a direct connection
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createApi, UnlinkedApiError, type UnlinkedApi, type UnlinkedConfig } from "./api.js";

export const VERSION = "0.1.0";

// ---- formatting helpers ----

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(e: unknown) {
  if (e instanceof UnlinkedApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `unlinked.ai API error (${e.status}): ${e.body.slice(0, 500)}\nURL: ${e.url}`,
        },
      ],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

function requireApiKey(api: UnlinkedApi, purpose: string) {
  if (!api.hasApiKey) {
    throw new Error(
      `UNLINKED_API_KEY is not set. ${purpose} requires authentication. ` +
        `Set UNLINKED_API_KEY in your environment or create ~/.unlinked/credentials.json.`
    );
  }
}

function formatProfile(p: {
  id: string;
  full_name?: string | null;
  headline?: string | null;
  industry?: string | null;
}): string {
  const parts = [`id: ${p.id}`];
  if (p.full_name) parts.push(`name: ${p.full_name}`);
  if (p.headline) parts.push(`headline: ${p.headline}`);
  if (p.industry) parts.push(`industry: ${p.industry}`);
  return parts.join(" | ");
}

// ---- builder ----

/**
 * Build a fresh `McpServer` bound to the given unlinked.ai config.
 * The returned server has no transport attached -- the caller connects it.
 */
export function buildServer(
  config: UnlinkedConfig,
  options: { instructions?: string } = {}
): McpServer {
  const api = createApi(config);

  const server = new McpServer(
    { name: "unlinked", version: VERSION },
    options.instructions ? { instructions: options.instructions } : {}
  );

  // ---- unlinked_me ----
  server.registerTool(
    "unlinked_me",
    {
      title: "Get my profile",
      description:
        "Return the authenticated caller's own unlinked.ai profile, plus connection and upload counts.",
      inputSchema: {},
    },
    async () => {
      try {
        requireApiKey(api, "Reading your profile");
        const { profile, counts } = await api.me();
        return textResult(
          `${formatProfile(profile)}\n` +
            `connections: ${counts.connections ?? 0} | uploads: ${counts.uploads ?? 0}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- unlinked_search_contacts ----
  server.registerTool(
    "unlinked_search_contacts",
    {
      title: "Search my contacts",
      description:
        "Semantic search restricted to the caller's own direct connections. Returns matching profiles " +
        "with a similarity score and a one-sentence reason each was included.",
      inputSchema: {
        query: z.string().min(1).describe("What kind of contact you're looking for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max results to return (default 10, max 25)"),
      },
    },
    async ({ query, limit }) => {
      try {
        requireApiKey(api, "Searching contacts");
        const { results } = await api.searchContacts(query, limit);
        if (!results.length) {
          return textResult(`No matching contacts found for "${query}".`);
        }
        return textResult(
          `${results.length} match(es) for "${query}":\n` +
            results
              .map((r) => `${formatProfile(r.profile)} | score: ${r.score.toFixed(3)}\n  ${r.reason}`)
              .join("\n")
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- unlinked_get_profile ----
  server.registerTool(
    "unlinked_get_profile",
    {
      title: "Get a profile",
      description:
        "Look up a profile by id. Only readable if it's your own profile or a direct connection of yours; " +
        "anything else returns not-found.",
      inputSchema: {
        profileId: z.string().min(1).describe("The profile id (uuid)"),
      },
    },
    async ({ profileId }) => {
      try {
        requireApiKey(api, "Reading profiles");
        const { profile, relationship } = await api.getProfile(profileId);
        return textResult(`${formatProfile(profile)} | relationship: ${relationship}`);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- unlinked_list_imports ----
  server.registerTool(
    "unlinked_list_imports",
    {
      title: "List my LinkedIn imports",
      description:
        "Return the caller's LinkedIn archive uploads plus counts of what has been ingested into their graph.",
      inputSchema: {},
    },
    async () => {
      try {
        requireApiKey(api, "Listing imports");
        const { uploads, ingested } = await api.listImports();
        const uploadLines = (uploads as Array<{ file_name?: string; created_at?: string }>)
          .map((u) => `- ${u.file_name ?? "unknown file"} (${u.created_at ?? "unknown date"})`)
          .join("\n");
        return textResult(
          `${uploads.length} upload(s)${uploadLines ? `:\n${uploadLines}` : "."}\n` +
            `ingested: connections=${ingested.connections ?? 0}, positions=${ingested.positions ?? 0}, ` +
            `education=${ingested.education ?? 0}, skills=${ingested.skills ?? 0}`
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- unlinked_draft_intro ----
  server.registerTool(
    "unlinked_draft_intro",
    {
      title: "Draft an intro",
      description:
        "Draft a short, forwardable intro message between the caller and one of their direct connections. " +
        "Read-only -- nothing is written to unlinked.ai.",
      inputSchema: {
        contactProfileId: z
          .string()
          .min(1)
          .describe("Profile id (uuid) of the direct connection to introduce yourself to"),
        context: z
          .string()
          .max(2000)
          .optional()
          .describe("Optional context on what you want out of the intro"),
      },
    },
    async ({ contactProfileId, context }) => {
      try {
        requireApiKey(api, "Drafting intros");
        const { draft, contact } = await api.draftIntro(contactProfileId, context);
        return textResult(`Draft intro to ${contact.full_name ?? contactProfileId}:\n\n${draft}`);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  return server;
}
