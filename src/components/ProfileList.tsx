'use client'

import React from 'react'
import { Box, Table, Avatar, Text } from '@radix-ui/themes'
import { Node } from '@/types/graph'
import { useRouter } from 'next/navigation'

interface ProfileListProps {
  nodes: Node[];
  onProfileClick?: (node: Node) => void;
}

export default function ProfileList({ nodes, onProfileClick }: ProfileListProps) {
  const router = useRouter()
  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Professional</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Industry</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>

        <Table.Body>
          {nodes.map((node) => (
            <Table.Row 
              key={node.id}
              onClick={() => {
                if (onProfileClick) {
                  onProfileClick(node);
                } else {
                  router.push(`/profiles/${node.id}`);
                }
              }}
              style={{ cursor: onProfileClick ? 'pointer' : 'default' }}
            >
              <Table.Cell>
                <Box style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Avatar
                    size="2"
                    src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(node.name)}`}
                    fallback={node.name[0]}
                  />
                  <Box>
                    <Text weight="medium">{node.name}</Text>
                    {node.__data?.headline && (
                      <Text size="2" color="gray">{node.__data.headline}</Text>
                    )}
                  </Box>
                </Box>
              </Table.Cell>
              <Table.Cell>{node.__data?.industry || 'Not specified'}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  )
}
