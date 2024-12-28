'use client'

import React from 'react'
import { Box, TextField, IconButton } from '@radix-ui/themes'
import { MagnifyingGlassIcon, DotsHorizontalIcon } from '@radix-ui/react-icons'

interface SearchBarProps {
  placeholder?: string;
}

export default function SearchBar({ placeholder = "Search the docs..." }: SearchBarProps) {
  return (
    <Box maxWidth="300px">
      <TextField.Root 
        size="3"
        placeholder={placeholder}
      >
        <TextField.Slot>
          <MagnifyingGlassIcon height="16" width="16" />
        </TextField.Slot>
        <TextField.Slot pr="3">
          <IconButton size="2" variant="ghost">
            <DotsHorizontalIcon height="16" width="16" />
          </IconButton>
        </TextField.Slot>
      </TextField.Root>
    </Box>
  )
}
