'use client'

import React from 'react'
import { useState, useEffect } from 'react'
import { Card, Flex, Box, Grid, Avatar, Text } from '@radix-ui/themes'
import Link from 'next/link'
import SearchBar from '@/components/SearchBar'
import type { Database } from '@/utils/supabase/types'

type Profile = Database['public']['Tables']['profiles']['Row']

interface ProfileGridProps {
  profiles: Profile[]
}

export default function ProfileGrid({ profiles }: ProfileGridProps) {
  const [query, setQuery] = useState('')
  const [filteredProfiles, setFilteredProfiles] = useState(profiles)

  useEffect(() => {
    const searchTerms = query.toLowerCase().split(' ')
    const filtered = profiles.filter(profile => {
      const searchableText = `${profile.first_name} ${profile.last_name} ${profile.headline} ${profile.industry}`.toLowerCase()
      return searchTerms.every(term => searchableText.includes(term))
    })
    setFilteredProfiles(filtered)
  }, [query, profiles])

  return (
    <React.Fragment>
      {/* Search Bar */}
      <Box mb="6">
        <SearchBar 
          placeholder="Search professionals by name, title, or company..."
          onChange={setQuery}
        />
      </Box>

      {/* Profiles Grid */}
      <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="4">
        {filteredProfiles.map((p: Profile) => (
          <Card key={p.id} asChild>
            <Link href={`/profiles/${p.id}`}>
              <Flex gap="3">
                <Avatar
                  size="4"
                  src={`https://api.dicebear.com/7.x/initials/svg?seed=${p.first_name} ${p.last_name}`}
                  fallback={`${p.first_name?.[0]}${p.last_name?.[0]}`}
                  radius="full"
                />
                <Box>
                  <Text as="div" size="2" weight="medium" mb="1">
                    {p.first_name} {p.last_name}
                  </Text>
                  {p.headline && (
                    <Text as="div" size="2" color="gray" style={{ 
                      whiteSpace: 'pre-wrap',
                      lineHeight: '1.5',
                      marginBottom: '8px'
                    }}>
                      {p.headline}
                    </Text>
                  )}
                  {p.industry && (
                    <Text as="div" size="1" color="gray" style={{
                      whiteSpace: 'pre-wrap',
                      lineHeight: '1.4'
                    }}>
                      {p.industry}
                    </Text>
                  )}
                </Box>
              </Flex>
            </Link>
          </Card>
        ))}
      </Grid>
    </React.Fragment>
  )
}
