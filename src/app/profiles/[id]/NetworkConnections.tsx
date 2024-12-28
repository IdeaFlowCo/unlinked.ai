// app/profiles/[id]/NetworkConnections.tsx
'use client'
import { Card, Text, Avatar, Box, Flex } from '@radix-ui/themes'
import { useInfiniteQuery } from '@tanstack/react-query'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { useInView } from 'react-intersection-observer'
import { useEffect } from 'react'

const PAGE_SIZE = 10

export default function NetworkConnections({ profileId }: { profileId: string }) {
    const { ref, inView } = useInView()
    const supabase = createClient()

    const {
        data,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        status,
    } = useInfiniteQuery({
        queryKey: ['connections', profileId],
        queryFn: async ({ pageParam = 0 }) => {
            const { data, error } = await supabase
                .from('connections')
                .select(`
          *,
          profile_b:profiles!connections_profile_id_b_fkey(*),
          profile_a:profiles!connections_profile_id_a_fkey(*)
        `)
                .or(`profile_id_a.eq.${profileId},profile_id_b.eq.${profileId}`)
                .range(pageParam * PAGE_SIZE, (pageParam + 1) * PAGE_SIZE - 1)
                .order('created_at', { ascending: false })

            if (error) throw error
            return data
        },
        getNextPageParam: (lastPage, pages) =>
            lastPage?.length === PAGE_SIZE ? pages.length : undefined,
        initialPageParam: 0,
    })

    useEffect(() => {
        if (inView && hasNextPage && !isFetchingNextPage) {
            fetchNextPage()
        }
    }, [inView, fetchNextPage, hasNextPage, isFetchingNextPage])

    return (
        <Flex direction="column" gap="3">
            {data?.pages.map((page, i) => (
                page.map(conn => {
                    const connectedProfile = conn.profile_id_a === profileId
                        ? conn.profile_b
                        : conn.profile_a
                    if (!connectedProfile) return null

                    const fullName = `${connectedProfile.first_name} ${connectedProfile.last_name}`.trim()

                    return (
                        <Card key={conn.id} asChild>
                            <Link href={`/profiles/${connectedProfile.id}`}>
                                <Flex gap="3" align="center" p="3">
                                    <Avatar
                                        size="3"
                                        fallback={fullName[0]}
                                    />
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
                    )
                })
            ))}

            <Box ref={ref} p="4" style={{ textAlign: 'center' }}>
                {isFetchingNextPage
                    ? <Text size="2" color="gray">Loading more...</Text>
                    : hasNextPage
                        ? <Text size="2" color="gray">Load more</Text>
                        : <Text size="2" color="gray">No more connections</Text>
                }
            </Box>
        </Flex>
    )
}
