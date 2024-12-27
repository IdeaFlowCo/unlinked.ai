'use client'

import React from 'react'
import { ForceGraph2D } from 'react-force-graph'
import { Database } from '@/utils/supabase/types'
import { Box } from '@radix-ui/themes'
import * as HoverCard from '@radix-ui/react-hover-card'

type Profile = Database['public']['Tables']['profiles']['Row']
type Company = Database['public']['Tables']['companies']['Row']
type Institution = Database['public']['Tables']['institutions']['Row']

interface Node {
  id: string
  name: string
  type: 'person' | 'company' | 'institution'
  data: Profile | Company | Institution
  x?: number
  y?: number
  vx?: number
  vy?: number
  index?: number
}

interface Link {
  source: string | Node
  target: string | Node
  type: 'works_at' | 'studied_at' | 'connected_to'
}

interface NetworkData {
  nodes: Node[]
  links: Link[]
}

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
        width: '100%',
        maxWidth: '100%',
        height: height,
        border: '1px solid var(--gray-5)',
        borderRadius: 'var(--radius-3)',
        overflow: 'hidden',
        margin: '0 auto'
      }}
    >
      <ForceGraph2D
        graphData={data}
        nodeLabel={(node: Node) => `${node.name} (${node.type})`}
        onNodeHover={(node, event) => {
          setHoveredNode(node as Node | null);
          if (event) {
            setMousePosition({ x: event.pageX, y: event.pageY });
          }
        }}
        nodeCanvasObject={(node: Node, ctx, globalScale) => {
          const label = node.name;
          const fontSize = 12/globalScale;
          // Calculate node size based on connections and type
          const connectionCount = data.links.filter(link => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            return sourceId === node.id || targetId === node.id;
          }).length;
          
          // Base size varies by node type (reduced base sizes)
          const baseSize = node.type === 'person' ? 5 : node.type === 'company' ? 6 : 7;
          
          // Use logarithmic scale for more subtle growth
          const sizeMultiplier = Math.log2(connectionCount + 1) * 1.2;
          const size = baseSize + sizeMultiplier;
          
          ctx.font = `${fontSize}px Sans-Serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          // Set color based on node type using Radix UI theme colors
          switch (node.type) {
            case 'person':
              ctx.fillStyle = '#7c66dc'; // violet-9
              // Draw circle for person
              ctx.beginPath();
              ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI);
              ctx.fill();
              break;
            case 'company':
              ctx.fillStyle = '#6e56cf'; // violet-10
              // Draw square for company
              ctx.fillRect(node.x! - size, node.y! - size, size * 2, size * 2);
              break;
            case 'institution':
              ctx.fillStyle = '#6547c7'; // violet-11
              // Draw triangle for institution
              ctx.beginPath();
              ctx.moveTo(node.x!, node.y! - size);
              ctx.lineTo(node.x! + size, node.y! + size);
              ctx.lineTo(node.x! - size, node.y! + size);
              ctx.closePath();
              ctx.fill();
              break;
            default:
              ctx.fillStyle = '#8e8e93'; // gray-8
              ctx.beginPath();
              ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI);
              ctx.fill();
          }
          
          // Draw label below node
          ctx.fillStyle = 'var(--gray-12)';
          ctx.fillText(label, node.x!, node.y! + size + fontSize);
        }}
        linkColor={(link: Link) => {
          switch (link.type) {
            case 'works_at':
              return 'rgba(120, 80, 250, 0.08)' // Very subtle violet for work relationships
            case 'studied_at':
              return 'rgba(80, 120, 250, 0.08)' // Very subtle blue for education
            default:
              return 'rgba(167, 139, 250, 0.08)' // Very subtle default for connections
          }
        }}
        linkWidth={0.2} // Even thinner lines for better visual balance
        onLinkClick={() => {}}  // Disable link interactions
        linkDirectionalParticles={0}
        onNodeClick={(node: Node) => onNodeClick?.(node)}
        width={containerWidth}
        height={height}
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
