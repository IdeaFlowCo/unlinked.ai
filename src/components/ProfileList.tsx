'use client'

import React from 'react'
import { Box, Table, Avatar, Text } from '@radix-ui/themes'
import { Node, Profile } from '@/types/graph'
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
            <Table.ColumnHeaderCell>Position &amp; Company</Table.ColumnHeaderCell>
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
                    {(node.__data as Profile)?.headline && (
                      <Text size="2" color="gray">{(node.__data as Profile).headline}</Text>
                    )}
                  </Box>
                </Box>
              </Table.Cell>
              <Table.Cell>
                {(() => {
                  const position = (node.__data as Profile)?.positions?.[0];
                  if (!position) return 'Position/Company Not Specified';
                  return (
                    <Box>
                      <Text weight="medium">{position.title}</Text>
                      {position.companies?.name && (
                        <Text size="2" color="gray">{position.companies.name}</Text>
                      )}
                    </Box>
                  );
                })()}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  )
}
