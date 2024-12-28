'use client'

import React from 'react'
import { Box, TextField } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>;
  placeholder?: string;
}

export default function SearchInput({ onSearch, placeholder = "Search..." }: SearchInputProps) {
  return (
    <Box style={{ width: '100%' }}>
      <TextField.Root
        size="3"
        placeholder={placeholder}
        onChange={(e) => {
          const value = e.target.value
          onSearch(value).catch(console.error)
        }}
      >
        <TextField.Slot>
          <MagnifyingGlassIcon height="16" width="16" />
        </TextField.Slot>
      </TextField.Root>
    </Box>
  )
}
