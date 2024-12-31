// app/profiles/ProfilesContainer.tsx
'use client'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useInView } from 'react-intersection-observer'
import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Text, Card, Flex } from '@radix-ui/themes'
import type { Profile } from '@/components/ProfileList'
import ProfileList from '@/components/ProfileList'
import SearchInput from '@/components/SearchInput'

const PAGE_SIZE = 10

interface ProfilesContainerProps {
    initialProfiles: Profile[]
}

export default function ProfilesContainer({ initialProfiles }: ProfilesContainerProps) {
    const [searchQuery, setSearchQuery] = useState('')
    const { ref, inView } = useInView()
    const supabase = createClient()

    const {
        data,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        status
    } = useInfiniteQuery({
        queryKey: ['profiles', searchQuery],
        queryFn: async ({ pageParam = 0 }) => {
            const query = supabase
                .from('profiles')
                .select(`
          *,
          positions:positions(
            *,
            companies(*)
          ),
          education:education(
            *,
            institutions(*)
          )
        `)
                .order('created_at', { ascending: false })
                .range(pageParam * PAGE_SIZE, (pageParam + 1) * PAGE_SIZE - 1)

            if (searchQuery) {
                query.or(`first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%`)
            }

            const { data, error } = await query
            if (error) throw error
            return data
        },
        initialData: {
            pages: [initialProfiles],
            pageParams: [0]
        },
        getNextPageParam: (lastPage, pages) =>
            lastPage.length === PAGE_SIZE ? pages.length : undefined,
        initialPageParam: 0,
    })

    useEffect(() => {
        if (inView && hasNextPage && !isFetchingNextPage) {
            fetchNextPage()
        }
    }, [inView, fetchNextPage, hasNextPage, isFetchingNextPage])

    if (status === 'error') {
        return (
            <Card size="2">
                <Flex direction="column" gap="3" p="4" align="center">
                    <Text size="3" color="red">Error loading data</Text>
                </Flex>
            </Card>
        )
    }

    const allProfiles = data?.pages.flat() || []

    return (
        <>
            <Flex
                direction="column"
                gap="4"
                style={{
                    position: 'sticky',
                    top: 0,
                    backgroundColor: 'var(--color-background)',
                    padding: '16px 0',
                    zIndex: 10,
                }}
            >
                <SearchInput
                    onSearch={async (query: string) => {
                        setSearchQuery(query)
                    }}
                    placeholder="Search professionals..."
                />
            </Flex>
            <ProfileList profiles={allProfiles} />
            <div ref={ref} style={{ padding: '20px', textAlign: 'center' }}>
                {isFetchingNextPage ? (
                    <Text size="2" color="gray">Loading more...</Text>
                ) : hasNextPage ? (
                    <Text size="2" color="gray">Load more</Text>
                ) : (
                    <Text size="2" color="gray">No more profiles</Text>
                )}
            </div>
            <Text size="2" color="gray" mt="2" align="center">
                {allProfiles.length} professionals
            </Text>
        </>
    )
}
