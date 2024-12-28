'use client'

import React from 'react'
import { ForceGraph2D } from 'react-force-graph'
import type { NodeObject as ForceGraphNode, GraphData } from 'react-force-graph'
import { Database } from '@/utils/supabase/types'
import { Box } from '@radix-ui/themes'
import * as HoverCard from '@radix-ui/react-hover-card'
import { forceManyBody, forceLink, forceCenter, Simulation } from 'd3-force'

type Profile = Database['public']['Tables']['profiles']['Row']
type Company = Database['public']['Tables']['companies']['Row']
type Institution = Database['public']['Tables']['institutions']['Row']

interface Node extends Omit<ForceGraphNode, 'id'> {
  id: string
  name: string
  type: 'person' | 'company' | 'institution'
  data: Profile | Company | Institution
  [key: string]: string | number | boolean | null | undefined | Node | Profile | Company | Institution | ForceGraphNode[keyof ForceGraphNode]
}

interface Link {
  source: Node
  target: Node
  type: 'works_at' | 'studied_at' | 'connected_to'
  [key: string]: string | Node | number | boolean | undefined  // Allow additional properties required by ForceGraph2D
}

type NetworkData = GraphData<Node, Link>

interface NetworkForceGraphProps {
  data: NetworkData
  onNodeClick?: (node: Node) => void
  height?: number
}

export default function NetworkForceGraph({ 
  data,
  onNodeClick,
  height = 600
}: NetworkForceGraphProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [hoveredNode, setHoveredNode] = React.useState<Node | null>(null);
  const [mousePosition, setMousePosition] = React.useState({ x: 0, y: 0 });

  React.useEffect(() => {
    if (!containerRef.current) return;
    
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  return (
    <Box
      ref={containerRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
        background: 'var(--gray-1)'
      }}
    >
      <ForceGraph2D
        graphData={data}
        nodeLabel={(node: ForceGraphNode) => `${(node as Node).name} (${(node as Node).type})`}
        onNodeHover={(node, event) => {
          setHoveredNode(node as Node | null);
          if (event) {
            setMousePosition({ x: event.pageX as number, y: event.pageY as number });
          }
        }}
        nodeCanvasObject={(node: ForceGraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const label = (node as Node).name;
          const fontSize = 12/globalScale;
          // Use a consistent base size for all nodes
          const size = 8;
          
          ctx.font = `${fontSize}px Sans-Serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          // Set color based on node type
          switch ((node as Node).type) {
            case 'person':
              ctx.fillStyle = '#7c66dc'; // vibrant violet
              break;
            case 'company':
              ctx.fillStyle = '#4f3ecc'; // deeper violet
              break;
            case 'institution':
              ctx.fillStyle = '#a07ffa'; // lighter lavender
              break;
            default:
              ctx.fillStyle = '#8e8e93'; // gray-8
          }
          
          // Draw circle for all node types
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI);
          ctx.fill();
          
          // Draw label below node
          ctx.fillStyle = 'var(--gray-12)';
          ctx.fillText(label, node.x!, node.y! + size + fontSize);
        }}
        linkColor={(link) => {
          switch (link.type) {
            case 'works_at':
              return 'rgba(120, 80, 250, 0.3)' // More visible violet for work relationships
            case 'studied_at':
              return 'rgba(80, 120, 250, 0.3)' // More visible blue for education
            default:
              return 'rgba(167, 139, 250, 0.3)' // More visible default for connections
          }
        }}
        linkWidth={1} // Thicker lines for better visibility
        onLinkClick={() => {}}  // Disable link interactions
        linkDirectionalParticles={0}
        onNodeClick={(node: ForceGraphNode) => onNodeClick?.(node as Node)}
        width={containerWidth}
        height={window.innerHeight}
        nodeRelSize={12}
        nodeVal={() => 1}
        warmupTicks={200}
        cooldownTime={5000}
        d3VelocityDecay={0.1}
        d3Force={(force: Simulation<ForceGraphNode, undefined>) => {
          force.force('charge', forceManyBody().strength(-1500))
               .force('link', forceLink().distance(250))
               .force('center', forceCenter().strength(0.03));
        }}
      />
      {hoveredNode && (
        <HoverCard.Root open={true}>
          <HoverCard.Trigger asChild>
            <div style={{ display: 'none' }} />
          </HoverCard.Trigger>
          <HoverCard.Content
            style={{
              position: 'fixed',
              left: mousePosition.x + 10,
              top: mousePosition.y + 10,
              backgroundColor: 'var(--color-panel)',
              padding: '12px',
              borderRadius: 'var(--radius-3)',
              boxShadow: 'var(--shadow-3)',
              zIndex: 1000,
              border: '1px solid var(--violet-6)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontWeight: 500, color: 'var(--violet-12)' }}>{hoveredNode.name}</div>
              <div style={{ color: 'var(--gray-11)', fontSize: '0.9em' }}>Type: {hoveredNode.type}</div>
              {hoveredNode.type === 'person' && (hoveredNode.data as Profile).headline && (
                <div style={{ color: 'var(--gray-11)', fontSize: '0.9em' }}>
                  {(hoveredNode.data as Profile).headline}
                </div>
              )}
            </div>
          </HoverCard.Content>
        </HoverCard.Root>
      )}
    </Box>
  )
}
