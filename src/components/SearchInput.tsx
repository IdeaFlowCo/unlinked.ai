'use client'

import React, { useCallback } from 'react'
import { Box, TextField } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'
import debounce from 'lodash/debounce'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>
  placeholder?: string
  disabled?: boolean
}

export default function SearchInput({
  onSearch,
  placeholder = "Search...",
  disabled = false
}: SearchInputProps) {
  // Debounce the search to prevent too many requests
  const debouncedSearch = useCallback(
    debounce(async (value: string) => {
      await onSearch(value)
    }, 300),
    [onSearch]
  )

  return (
    <Box style={{ width: '100%' }}>
      <TextField.Root
        size="3"
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const value = e.target.value
          debouncedSearch(value).catch(console.error)
        }}
      >
        <TextField.Slot>
          <MagnifyingGlassIcon height="16" width="16" />
        </TextField.Slot>
      </TextField.Root>
    </Box>
  )
}
