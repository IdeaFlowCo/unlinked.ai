import { createClient } from "@/utils/supabase/server";
import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { NextResponse } from "next/server";

// Create OpenAI client (server-side)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Create Pinecone client (server-side)
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

// Pinecone index name
const PINECONE_INDEX = "unlinked";

// Max number of search results to return
const MAX_RESULTS = 10;

export async function POST(request: Request) {
  try {
    // Parse the request body
    const body = await request.json();
    const { query } = body;

    // Validate the query parameter
    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Invalid query parameter" },
        { status: 400 }
      );
    }

    // Generate embedding for the search query
    let embedding;
    try {
      embedding = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: query.trim(),
      });
    } catch (error) {
      console.error("OpenAI embedding error:", error);
      return NextResponse.json(
        { error: "Failed to generate embedding" },
        { status: 500 }
      );
    }

    // Search Pinecone with the embedding
    let searchResponse;
    try {
      const index = pinecone.index(PINECONE_INDEX);
      searchResponse = await index.query({
        vector: embedding.data[0].embedding,
        topK: MAX_RESULTS,
        includeMetadata: true,
      });
    } catch (error) {
      console.error("Pinecone query error:", error);
      return NextResponse.json(
        { error: "Vector search failed" },
        { status: 500 }
      );
    }

    // Check if we got any matches
    if (!searchResponse.matches || searchResponse.matches.length === 0) {
      return NextResponse.json({ profiles: [] });
    }

    // Get the profile IDs from the search results
    const profileIds = searchResponse.matches.map((match) => match.id);

    // Create server-side Supabase client
    const supabase = await createClient();

    // Fetch the full profile data from Supabase
    try {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select(
          `
          *,
          positions:positions(
            *,
            companies(*)
          ),
          education:education(
            *,
            institutions(*)
          ),
          skills(*)
        `
        )
        .in("id", profileIds);

      if (error) {
        throw error;
      }

      // Return the profiles, preserving the ranking order from vector search
      const orderedProfiles = profileIds
        .map((id) => profiles?.find((p) => p.id === id))
        .filter(Boolean);

      return NextResponse.json({ profiles: orderedProfiles });
    } catch (error) {
      console.error("Supabase query error:", error);
      return NextResponse.json(
        { error: "Database query failed" },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("AI search error:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
