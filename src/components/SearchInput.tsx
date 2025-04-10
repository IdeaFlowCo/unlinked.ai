"use client";

import React from "react";
import { TextField, Flex } from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";

interface SearchInputProps {
  onSearch: (query: string) => void;
  value?: string;
  placeholder?: string;
  isLoading?: boolean;
  searchWithAI?: React.ReactNode;
}

export default function SearchInput({
  onSearch,
  value = "",
  placeholder = "",
  isLoading = false,
  searchWithAI,
}: SearchInputProps) {
  return (
    <Flex align="center" gap="2" width="100%">
      <TextField.Root
        value={value}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={placeholder}
        style={{ flexGrow: 1 }}
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

      {searchWithAI}
    </Flex>
  );
}
