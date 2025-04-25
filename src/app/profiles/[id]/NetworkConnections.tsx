// app/profiles/[id]/NetworkConnections.tsx
"use client";
import {
  Card,
  Text,
  Avatar,
  Box,
  Flex,
  Heading,
  Button,
} from "@radix-ui/themes";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import Link from "next/link";
import { useInView } from "react-intersection-observer";
import { useEffect, useState, useMemo } from "react";
import SearchInput from "@/components/SearchInput";
import { StarFilledIcon } from "@radix-ui/react-icons";

const PAGE_SIZE = 50;

export default function NetworkConnections({
  profileId,
}: {
  profileId: string;
}) {
  const { ref, inView } = useInView();
  const supabase = createClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [isAISearchActive, setIsAISearchActive] = useState(false);
  const [isAISearchLoading, setIsAISearchLoading] = useState(false);
  const [AISearchResults, setAISearchResults] = useState<any[]>([]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["connections", profileId],
      queryFn: async ({ pageParam = 0 }) => {
        const query = supabase
          .from("connections")
          .select(
            `
            *,
            profile_b:profiles!connections_profile_id_b_fkey(*),
            profile_a:profiles!connections_profile_id_a_fkey(*)
          `
          )
          .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`)
          .range(pageParam * PAGE_SIZE, (pageParam + 1) * PAGE_SIZE - 1)
          .order("created_at", { ascending: false });

        const { data, error } = await query;

        if (error) {
          console.error("Supabase Query Error:", error);
          throw error;
        }

        return data;
      },
      getNextPageParam: (lastPage, pages) =>
        lastPage?.length === PAGE_SIZE ? pages.length : undefined,
      initialPageParam: 0,
    });

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, fetchNextPage, hasNextPage, isFetchingNextPage]);

  // Function to search with AI
  const searchWithAI = async (query: string) => {
    if (!query.trim()) return;

    setIsAISearchLoading(true);
    try {
      const response = await fetch("/api/ai-search-connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, profileId }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      setAISearchResults(data.connections || []);
      setIsAISearchActive(true);
    } catch (error) {
      console.error("AI Search failed:", error);
    } finally {
      setIsAISearchLoading(false);
    }
  };

  // Turn off AI search when user types new search query
  useEffect(() => {
    if (isAISearchActive) {
      setIsAISearchActive(false);
    }
  }, [searchQuery]);

  const connections = useMemo(() => {
    if (isAISearchActive) return AISearchResults;

    if (!data?.pages) return [];
    const allConnections = data.pages.flatMap((page) => page);

    if (!searchQuery) return allConnections;

    const searchLower = searchQuery.toLowerCase();
    return allConnections.filter((conn) => {
      const connectedProfile =
        conn.profile_id_a === profileId ? conn.profile_b : conn.profile_a;
      return connectedProfile?.full_name?.toLowerCase().startsWith(searchLower);
    });
  }, [data?.pages, searchQuery, profileId, isAISearchActive, AISearchResults]);

  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="5" mb="2">
        Connections
      </Heading>
      <SearchInput
        onSearch={setSearchQuery}
        value={searchQuery}
        placeholder="Search connections..."
        isLoading={isAISearchLoading}
        searchWithAI={
          <Button
            variant="soft"
            color="iris"
            onClick={() => searchWithAI(searchQuery)}
            disabled={isAISearchLoading || !searchQuery.trim()}
          >
            <StarFilledIcon />
            {isAISearchLoading ? "Searching..." : "Search with AI"}
          </Button>
        }
      />
      {isAISearchActive && (
        <Text size="2" color="gray">
          Showing AI search results for "{searchQuery}"
        </Text>
      )}
      {connections.map((conn) => {
        const connectedProfile =
          conn.profile_id_a === profileId ? conn.profile_b : conn.profile_a;
        if (!connectedProfile) return null;

        const fullName =
          connectedProfile.full_name?.trim() || "Unnamed Profile";

        return (
          <Card
            key={`${conn.id}-${conn.profile_id_a}-${
              conn.profile_id_b
            }-${Math.random()}`}
            asChild
          >
            <Link href={`/profiles/${connectedProfile.id}`}>
              <Flex gap="3" align="center" p="3">
                <Avatar size="3" fallback={fullName.charAt(0).toUpperCase()} />
                <Box>
                  <Text as="div" size="2" weight="bold">
                    {fullName}
                  </Text>
                  {connectedProfile.headline && (
                    <Text as="div" size="2" color="gray">
                      {connectedProfile.headline}
                    </Text>
                  )}
                </Box>
              </Flex>
            </Link>
          </Card>
        );
      })}

      {!isAISearchActive && (
        <Box ref={ref} p="4" style={{ textAlign: "center" }}>
          {isFetchingNextPage ? (
            <Text size="2" color="gray">
              Loading more...
            </Text>
          ) : hasNextPage ? (
            <Text size="2" color="gray">
              Load more
            </Text>
          ) : (
            <Text size="2" color="gray">
              No more connections
            </Text>
          )}
        </Box>
      )}
    </Flex>
  );
}
