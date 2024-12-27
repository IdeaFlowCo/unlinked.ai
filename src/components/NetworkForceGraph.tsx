'use client'

import React from 'react'
import { ForceGraph2D } from 'react-force-graph'
import { Database } from '@/utils/supabase/types'
import { Box } from '@radix-ui/themes'

type Profile = Database['public']['Tables']['profiles']['Row']
type Company = Database['public']['Tables']['companies']['Row']
type Institution = Database['public']['Tables']['institutions']['Row']

interface Node {
  id: string
  name: string
  type: 'person' | 'company' | 'institution'
  data: Profile | Company | Institution
}

interface Link {
  source: string
  target: string
  type: 'works_at' | 'studied_at' | 'connected_to'
}

interface NetworkData {
  nodes: Node[]
  links: Link[]
}

interface NetworkForceGraphProps {
  data: NetworkData
  onNodeClick?: (node: Node) => void
  width?: number
  height?: number
}

export default function NetworkForceGraph({ 
  data,
  onNodeClick,
  width = 800,
  height = 600
}: NetworkForceGraphProps) {
  return (
    <Box
      style={{
        width: width,
        height: height,
        border: '1px solid var(--gray-5)',
        borderRadius: 'var(--radius-3)',
        overflow: 'hidden'
      }}
    >
      <ForceGraph2D
        graphData={data}
        nodeLabel={(node: Node) => `${node.name} (${node.type})`}
        nodeColor={(node: Node) => {
          switch (node.type) {
            case 'person':
              return '#0091FF'  // blue
            case 'company':
              return '#30A46C'  // green
            case 'institution':
              return '#FFA03C'  // amber
            default:
              return '#8E8E93'  // gray
          }
        }}
        linkColor={() => 'var(--gray-8)'}
        nodeRelSize={6}
        linkWidth={1}
        linkDirectionalParticles={2}
        linkDirectionalParticleSpeed={0.005}
        onNodeClick={(node: Node) => onNodeClick?.(node)}
        width={width}
        height={height}
      />
    </Box>
  )
}
