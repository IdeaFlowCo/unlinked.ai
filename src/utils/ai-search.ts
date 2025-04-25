import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY || "",
});

// Get the index
const index = pinecone.index("unlinked");

// Minimum similarity score threshold
const MIN_SIMILARITY_SCORE = 0.1;

export interface SemanticSearchResult {
  id: string;
  score: number;
  metadata?: {
    profileId: string;
    headline?: string;
  };
}

/**
 * Performs semantic search using OpenAI embeddings and Pinecone
 * @param query Search query string
 * @param topK Number of results to return (default: 50)
 * @param filterIds Optional array of profile IDs to filter results
 * @returns Array of matched IDs with their similarity scores
 */
export async function semanticSearch(
  query: string,
  topK: number = 50,
  filterIds?: string[]
): Promise<SemanticSearchResult[]> {
  if (!query || typeof query !== "string") {
    throw new Error("Query must be a non-empty string");
  }

  // Generate embedding using OpenAI's large embedding model
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query,
  });

  //   console.log("filterIds:", filterIds);
  const embedding = embeddingResponse.data[0].embedding;

  // Debug log for filter
  console.log(
    "Applying filter:",
    filterIds ? { metadata: { profileId: { $in: filterIds } } } : "no filter"
  );

  const queryResult = await index.query({
    vector: embedding,
    topK,
    includeMetadata: true,
    filter: filterIds ? { profileId: { $in: filterIds } } : undefined,
  });

  // Log the filter and the full query parameters
  //   console.log(
  //     "Full query parameters:",
  //     JSON.stringify(
  //       {
  //         topK,
  //         includeMetadata: true,
  //         filter: filterIds ? { id: { $in: filterIds } } : undefined,
  //       },
  //       null,
  //       2
  //     )
  //   );

  // Filter and map results
  return (
    queryResult.matches
      ?.filter(
        (
          match
        ): match is {
          id: string;
          score: number;
          metadata?: { profileId: string; headline?: string };
        } => match.score !== undefined && match.score >= MIN_SIMILARITY_SCORE
      )
      .map((match) => ({
        id: match.id,
        score: match.score,
        metadata: match.metadata,
      })) || []
  );
}
