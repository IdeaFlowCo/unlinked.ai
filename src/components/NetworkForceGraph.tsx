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
              return 'var(--blue-9)'
            case 'company':
              return 'var(--green-9)'
            case 'institution':
              return 'var(--amber-9)'
            default:
              return 'var(--gray-9)'
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
