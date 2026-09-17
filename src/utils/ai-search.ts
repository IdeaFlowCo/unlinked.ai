import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

/**
 * Shared semantic-search helpers.
 *
 * IMPORTANT: every third-party client in this module is constructed lazily,
 * inside a function, at request time. Constructing `new OpenAI()` /
 * `new Pinecone()` at module scope makes `next build` fail (page-data
 * collection imports route modules with no env present), and it also makes a
 * single missing env var crash the whole deployment instead of one endpoint.
 */

export const PINECONE_INDEX_NAME = "unlinked";
export const EMBEDDING_MODEL = "text-embedding-3-large";

/** Chat model used for re-ranking / drafting. Overridable via env. */
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

/** Minimum cosine similarity a Pinecone match must clear to be returned. */
export const MIN_SIMILARITY_SCORE = 0.1;

/**
 * Pinecone `$in` filters are bounded by request size, and LinkedIn exports
 * routinely produce thousands of connections, so filtered queries are fanned
 * out in chunks and merged.
 */
const MAX_FILTER_IDS_PER_QUERY = 500;

export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(`Missing required environment variable: ${varName}`);
    this.name = "MissingEnvError";
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingEnvError(name);
  return value;
}

/** Lazily construct an OpenAI client. Never call this at module scope. */
export function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
}

/** Lazily construct the Pinecone index handle. Never call this at module scope. */
export function getPineconeIndex() {
  const pinecone = new Pinecone({ apiKey: requireEnv("PINECONE_API_KEY") });
  return pinecone.index(PINECONE_INDEX_NAME);
}

export interface SemanticSearchResult {
  id: string;
  score: number;
  metadata?: {
    profileId: string;
    headline?: string;
  };
}

/** Embed one or more strings with the shared embedding model. */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
  });
  return response.data.map((item) => item.embedding);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Performs semantic search using OpenAI embeddings and Pinecone.
 *
 * @param query Search query string
 * @param topK Number of results to return (default: 50)
 * @param filterIds Optional array of profile IDs to restrict results to
 * @returns Matches, deduplicated by profileId, sorted by descending score
 */
export async function semanticSearch(
  query: string,
  topK: number = 50,
  filterIds?: string[]
): Promise<SemanticSearchResult[]> {
  if (!query || typeof query !== "string") {
    throw new Error("Query must be a non-empty string");
  }

  if (filterIds && filterIds.length === 0) return [];

  const [embedding] = await embedTexts([query]);
  const index = getPineconeIndex();

  const idBatches = filterIds
    ? chunk(filterIds, MAX_FILTER_IDS_PER_QUERY)
    : [null];

  const responses = await Promise.all(
    idBatches.map((batch) =>
      index.query({
        vector: embedding,
        topK,
        includeMetadata: true,
        filter: batch ? { profileId: { $in: batch } } : undefined,
      })
    )
  );

  // Merge batches, drop low-similarity matches, and keep the best-scoring
  // vector per profile (a profile may have more than one vector in the index
  // from earlier iterations of the embedding pipeline).
  const bestByProfile = new Map<string, SemanticSearchResult>();

  for (const response of responses) {
    for (const match of response.matches ?? []) {
      if (match.score === undefined || match.score < MIN_SIMILARITY_SCORE) {
        continue;
      }
      const metadata = match.metadata as
        | { profileId?: string; headline?: string }
        | undefined;
      const profileId = metadata?.profileId ?? match.id;
      if (!profileId) continue;

      const existing = bestByProfile.get(profileId);
      if (existing && existing.score >= match.score) continue;

      bestByProfile.set(profileId, {
        id: match.id,
        score: match.score,
        metadata: { profileId, headline: metadata?.headline },
      });
    }
  }

  return Array.from(bestByProfile.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
