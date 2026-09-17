/**
 * Thin wrapper around the unlinked.ai agent REST API.
 *
 * Configuration (priority order):
 *   1. UNLINKED_API_KEY env var   — the `ul_…` agent key
 *   2. ~/.unlinked/credentials.json  — { apiKey, baseUrl }
 *
 * Auth: `Authorization: Bearer ${apiKey}` on every request.
 *
 * Default base URL: https://www.unlinked.ai  (overridable via
 *   UNLINKED_BASE_URL env var or credentials.json baseUrl field).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://www.unlinked.ai";
const CREDENTIALS_PATH = join(homedir(), ".unlinked", "credentials.json");

// ---- types ----

export interface UnlinkedConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface Profile {
  id: string;
  full_name?: string | null;
  headline?: string | null;
  summary?: string | null;
  industry?: string | null;
  [k: string]: unknown;
}

export interface ContactSearchHit {
  profile: Profile;
  score: number;
  reason: string;
}

export class UnlinkedApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string
  ) {
    super(`unlinked.ai API ${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = "UnlinkedApiError";
  }
}

// ---- config loading ----

function loadCredentialsFile(): Partial<UnlinkedConfig> {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<{ apiKey: string; baseUrl: string }>;
    return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
  } catch {
    return {};
  }
}

export function getConfig(): UnlinkedConfig {
  const fileCreds = loadCredentialsFile();
  const baseUrl = (
    process.env.UNLINKED_BASE_URL ||
    fileCreds.baseUrl ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const apiKey = process.env.UNLINKED_API_KEY || fileCreds.apiKey;
  return { baseUrl, apiKey };
}

// ---- HTTP factory ----

function makeRequest(config: UnlinkedConfig) {
  return async function request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(config.baseUrl + path);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const text = await res.text();
    if (!res.ok) throw new UnlinkedApiError(res.status, text, url.toString());
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  };
}

// ---- API methods ----

function buildApiMethods(request: ReturnType<typeof makeRequest>) {
  return {
    me: () => request<{ profile: Profile; counts: Record<string, number> }>("GET", "/api/me"),

    getProfile: (id: string) =>
      request<{ profile: Profile; relationship: string }>(
        "GET",
        `/api/profiles/${encodeURIComponent(id)}`
      ),

    listImports: () =>
      request<{ uploads: unknown[]; ingested: Record<string, number> }>(
        "GET",
        "/api/imports"
      ),

    searchContacts: (query: string, limit?: number) =>
      request<{ results: ContactSearchHit[] }>("POST", "/api/search-contacts", {
        body: { query, ...(limit ? { limit } : {}) },
      }),

    draftIntro: (contactProfileId: string, context?: string) =>
      request<{ draft: string; contact: Profile }>("POST", "/api/draft-intro", {
        body: { contactProfileId, ...(context ? { context } : {}) },
      }),
  };
}

/** API client type. */
export type UnlinkedApi = ReturnType<typeof buildApiMethods> & {
  baseUrl: string;
  hasApiKey: boolean;
};

/** Create a per-request API client bound to the given config. */
export function createApi(config: UnlinkedConfig): UnlinkedApi {
  const request = makeRequest(config);
  return {
    ...buildApiMethods(request),
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
  };
}
