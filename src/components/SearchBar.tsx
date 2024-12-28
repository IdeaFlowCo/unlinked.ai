'use client'

import React from 'react'
import { Box, TextField } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'

interface SearchBarProps {
  placeholder?: string;
  onChange?: (value: string) => void;
}

export default function SearchBar({ placeholder = "Search...", onChange }: SearchBarProps) {
  return (
    <Box style={{ maxWidth: '400px' }}>
      <TextField.Root 
        size="3" 
        variant="soft"
        placeholder={placeholder}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value)}
      >
        <TextField.Slot>
          <MagnifyingGlassIcon height="16" width="16" />
        </TextField.Slot>
      </TextField.Root>
    </Box>
  )
}
