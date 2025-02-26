import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { createClient } from "@/utils/supabase/server";
import type { Profile } from "@/components/ProfileList";

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
const MIN_SIMILARITY_SCORE = 0.25;

export async function POST(request: NextRequest) {
  try {
    // Parse the request body
    const { query } = await request.json();

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Query must be a non-empty string" },
        { status: 400 }
      );
    }

    // Generate embedding using OpenAI's large embedding model
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: query,
    });

    const embedding = embeddingResponse.data[0].embedding;

    const queryResult = await index.query({
      vector: embedding,
      topK: 50,
      includeMetadata: true,
    });

    // Filter results by minimum similarity score
    const filteredMatches = queryResult.matches.filter(
      (match) =>
        match.score !== undefined && match.score >= MIN_SIMILARITY_SCORE
    );

    // Extract profile IDs from the filtered results
    const profileIds = filteredMatches.map((match) => match.id);

    if (profileIds.length === 0) {
      return NextResponse.json({ profiles: [] });
    }

    // Fetch the full profile data from Supabase using the IDs
    const supabase = await createClient();
    const { data, error } = await supabase
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
        )
      `
      )
      .in("id", profileIds);

    if (error) {
      console.error("Supabase error:", error);
      return NextResponse.json(
        { error: "Failed to fetch profiles" },
        { status: 500 }
      );
    }

    // Sort results to match the order from Pinecone
    const sortedResults = profileIds
      .map((id) => data?.find((profile: Profile) => profile.id === id))
      .filter(Boolean);

    return NextResponse.json({ profiles: sortedResults });
  } catch (error) {
    console.error("AI search failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
