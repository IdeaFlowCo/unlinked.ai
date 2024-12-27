'use client'

import React, { useState, ChangeEvent } from 'react'
import { Box, Flex, Text } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>
  placeholder?: string
  disabled?: boolean
}

export default function SearchInput({ onSearch, placeholder = 'Search...', disabled = false }: SearchInputProps) {
  const [query, setQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim() && !isSearching) {
      setIsSearching(true)
      setError(null)
      try {
        await onSearch(query.trim())
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setIsSearching(false)
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <Box>
        <Flex direction="column" gap="2">
          <Flex gap="3" align="center" className="relative">
            <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">
              <MagnifyingGlassIcon height="16" width="16" />
            </div>
            <input
              type="text"
              className="w-full px-10 py-2 border rounded-md bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={placeholder}
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
              disabled={disabled || isSearching}
            />
          </Flex>
          {error && (
            <Text size="1" color="red">
              {error}
            </Text>
          )}
        </Flex>
      </Box>
    </form>
  )
}
