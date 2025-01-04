// app/profiles/ProfilesContainer.tsx
'use client'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useInView } from 'react-intersection-observer'
import { useEffect, useState, useCallback, useTransition, useMemo } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Text, Card, Flex, Badge } from '@radix-ui/themes'
import debounce from 'lodash/debounce'
import type { Profile } from '@/components/ProfileList'
import ProfileList from '@/components/ProfileList'
import SearchInput from '@/components/SearchInput'

const DEBOUNCE_MS = 300
const PAGE_SIZE = 10

interface ProfilesContainerProps {
    initialProfiles: Profile[]
}

export default function ProfilesContainer({ initialProfiles }: ProfilesContainerProps) {
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    const [isPending, startTransition] = useTransition()
    const { ref, inView } = useInView()
    const supabase = createClient()

    const debouncedSetSearch = useCallback(
        (value: string) => {
            startTransition(() => {
                setDebouncedQuery(value);
            });
        },
        [startTransition, setDebouncedQuery]
    );

    const debouncedSearch = useMemo(
        () => debounce(debouncedSetSearch, DEBOUNCE_MS),
        [debouncedSetSearch]
    );

    useEffect(() => {
        return () => {
            debouncedSearch.cancel();
        };
    }, [debouncedSearch]);

    const {
        data,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isLoading,
        error
    } = useInfiniteQuery({
        queryKey: ['profiles', debouncedQuery],
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

            if (debouncedQuery) {
                query.or(
                    `full_name.ilike.%${debouncedQuery}%,` +
                    `headline.ilike.%${debouncedQuery}%`
                )
            }

            const { data, error } = await query
            if (error) throw error
            return data
        },
        initialData: debouncedQuery
            ? undefined
            : {
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

    const allProfiles = data?.pages
        .flat()
        .filter(
            (profile, index, self) =>
                index === self.findIndex((p) => p.id === profile.id)
        ) || []

    if (error) {
        return (
            <Card size="2">
                <Flex direction="column" gap="3" p="4" align="center">
                    <Text size="3" color="red">Error loading profiles</Text>
                </Flex>
            </Card>
        )
    }

    return (
        <>
            <Flex
                direction="column"
                gap="4"
                style={{
                    position: 'sticky',
                    top: 0,
                    backgroundColor: 'var(--color-background)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    padding: '16px',
                    zIndex: 10,
                    borderBottom: '1px solid var(--gray-4)',
                    marginTop: '-65px',
                    background: 'rgba(255, 255, 255, 0.8)',
                }}
            >
                <SearchInput
                    onSearch={(query: string) => {
                        setSearchQuery(query)
                        debouncedSearch(query)
                    }}
                    value={searchQuery}
                    placeholder="Search professionals..."
                    isLoading={isPending || isLoading}
                />
            </Flex>

            {allProfiles.length === 0 && !isLoading ? (
                <Card size="2">
                    <Flex direction="column" gap="3" p="4" align="center">
                        <Text size="3" color="gray">
                            {debouncedQuery
                                ? `No results found for "${debouncedQuery}"`
                                : 'No profiles available'}
                        </Text>
                    </Flex>
                </Card>
            ) : (
                <ProfileList profiles={allProfiles} />
            )}

            <Flex
                ref={ref}
                justify="center"
                align="center"
                py="4"
                gap="2"
                style={{
                    minHeight: '60px',
                    background: 'linear-gradient(to bottom, transparent, var(--gray-1))'
                }}
            >
                {isFetchingNextPage ? (
                    <Flex gap="2" align="center">
                        <div className="loading-spinner" />
                        <Text size="2" color="gray">Loading more profiles...</Text>
                    </Flex>
                ) : hasNextPage ? (
                    <Text size="2" color="gray">Scroll to load more</Text>
                ) : allProfiles.length > 0 ? (
                    <Text size="2" color="gray">No more profiles to load</Text>
                ) : null}
            </Flex>

            {allProfiles.length > 0 && (
                <Flex justify="center" pb="4">
                    <Badge size="1" variant="soft">
                        {allProfiles.length} professional{allProfiles.length === 1 ? '' : 's'} found
                    </Badge>
                </Flex>
            )}
        </>
    )
}
