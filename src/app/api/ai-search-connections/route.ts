import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { semanticSearch, SemanticSearchResult } from "@/utils/ai-search";

export async function POST(request: NextRequest) {
  try {
    // Parse the request body
    const { query, profileId } = await request.json();

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Query must be a non-empty string" },
        { status: 400 }
      );
    }

    if (!profileId) {
      return NextResponse.json(
        { error: "Profile ID is required" },
        { status: 400 }
      );
    }

    // First, fetch all connections for the user
    const supabase = await createClient();
    const { data: connections, error: connectionsError } = await supabase
      .from("connections")
      .select(
        `
        *,
        profile_b:profiles!connections_profile_id_b_fkey(*),
        profile_a:profiles!connections_profile_id_a_fkey(*)
      `
      )
      .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`);

    if (connectionsError) {
      console.error("Supabase error:", connectionsError);
      return NextResponse.json(
        { error: "Failed to fetch connections" },
        { status: 500 }
      );
    }

    // Get the IDs of all connected profiles
    const connectedProfileIds = connections.map((conn) =>
      conn.profile_id_a === profileId ? conn.profile_id_b : conn.profile_id_a
    );

    if (connectedProfileIds.length === 0) {
      return NextResponse.json({ connections: [] });
    }

    // console.log("connectedProfileIds:", connectedProfileIds);

    // Perform semantic search only on connected profiles
    const searchResults = await semanticSearch(query, 10, connectedProfileIds);

    if (searchResults.length === 0) {
      return NextResponse.json({ connections: [] });
    }

    // Map search results back to connections
    const sortedConnections = searchResults
      .map((result: SemanticSearchResult) =>
        connections.find(
          (conn) =>
            conn.profile_id_a === result.metadata?.profileId ||
            conn.profile_id_b === result.metadata?.profileId
        )
      )
      .filter(Boolean);

    return NextResponse.json({ connections: sortedConnections });
  } catch (error) {
    console.error("AI search failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
