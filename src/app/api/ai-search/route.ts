import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { semanticSearch } from "@/utils/ai-search";
import type { Profile } from "@/components/ProfileList";

type SemanticSearchResult = {
  id: string;
  score: number;
  values: any[];
  metadata: {
    headline: string;
    profileId: string;
  };
};

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

    // Get semantically similar profiles
    const searchResults = (await semanticSearch(
      query
    )) as SemanticSearchResult[];

    if (searchResults.length === 0) {
      return NextResponse.json({ profiles: [] });
    }

    // Extract profile IDs from the results
    const profileIds = searchResults
      .filter(
        (result): result is SemanticSearchResult =>
          result.metadata?.profileId != null
      )
      .map((result) => result.metadata.profileId);

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

    // Sort results to match the order from semantic search
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
