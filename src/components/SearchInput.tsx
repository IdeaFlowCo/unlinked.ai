'use client'

import React from 'react'
import { TextField } from '@radix-ui/themes'
import { MagnifyingGlassIcon } from '@radix-ui/react-icons'

interface SearchInputProps {
  onSearch: (query: string) => void
  value?: string
  placeholder?: string
  isLoading?: boolean
}

export default function SearchInput({
  onSearch,
  value = '',
  placeholder = '',
  isLoading = false
}: SearchInputProps) {
  return (
    <TextField.Root
      value={value}
      onChange={(e) => onSearch(e.target.value)}
      placeholder={placeholder}
    >
      <TextField.Slot>
        <MagnifyingGlassIcon height="16" width="16" />
      </TextField.Slot>

      {isLoading && (
        <TextField.Slot>
          <div className="loading-spinner-small" />
        </TextField.Slot>
      )}
    </TextField.Root>
  )
}
