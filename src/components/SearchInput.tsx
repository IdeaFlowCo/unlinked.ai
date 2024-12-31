'use client'

import React, { useCallback, useMemo } from 'react'
import { TextField } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'
import debounce from 'lodash/debounce'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>
  placeholder?: string
  disabled?: boolean
}

export default function SearchInput({
  onSearch,
  placeholder = 'Search...',
  disabled = false
}: SearchInputProps) {
  // Create a memoized debounced search function
  const debouncedSearch = useCallback(
    (query: string) => {
      return onSearch(query)
    },
    [onSearch]
  )

  // Initialize the debounced function outside the callback
  const debouncedSearchWithDelay = useMemo(
    () => debounce(debouncedSearch, 300),
    [debouncedSearch]
  )

  return (
    <TextField.Root
      size="3"
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        const value = e.target.value
        void debouncedSearchWithDelay(value)
      }}
    >
      <TextField.Slot>
        <MagnifyingGlassIcon height="16" width="16" />
      </TextField.Slot>
    </TextField.Root>
  )
}
