'use client'

import React from 'react'
import { Box, Table, Avatar } from '@radix-ui/themes'
import { Node } from '@/types/graph'

interface ProfileListProps {
  nodes: Node[];
  onProfileClick?: (node: Node) => void;
}

export default function ProfileList({ nodes, onProfileClick }: ProfileListProps) {
  return (
    <Box style={{ height: '100%', overflowY: 'auto' }}>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>

        <Table.Body>
          {nodes.map((node) => (
            <Table.Row 
              key={node.id}
              onClick={() => onProfileClick?.(node)}
              style={{ cursor: onProfileClick ? 'pointer' : 'default' }}
            >
              <Table.Cell>
                <Box style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Avatar
                    size="2"
                    src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(node.name)}`}
                    fallback={node.name[0]}
                  />
                  {node.name}
                </Box>
              </Table.Cell>
              <Table.Cell>{node.type}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  )
}
