'use client'

import { useCallback, useEffect, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { CustomGraphData, Node, NodeObject } from '@/types/graph'

interface NetworkForceGraphProps {
  data: CustomGraphData;
  height?: number;
  onNodeClick?: (node: Node) => void;
}

export default function NetworkForceGraph({ 
  data, 
  height = 600,
  onNodeClick 
}: NetworkForceGraphProps) {
  const graphRef = useRef<ForceGraph2D>(null)

  useEffect(() => {
    if (graphRef.current) {
      // Increase node repulsion for better spacing
      graphRef.current.d3Force('charge')?.strength(-400)
      // Reduce link force for more natural layout
      graphRef.current.d3Force('link')?.distance(100)
    }
  }, [])

  const handleNodeClick = useCallback((node: NodeObject) => {
    if (onNodeClick && 'type' in node) {
      onNodeClick(node as Node)
    }
  }, [onNodeClick])

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={data}
      height={height}
      width={window.innerWidth - 100}
      nodeLabel={null}
      nodeColor={(node: NodeObject) => {
        if (!('type' in node)) return '#718096'
        switch ((node as Node).type) {
          case 'person':
            return '#3182CE'
          case 'company':
            return '#38A169'
          case 'institution':
            return '#D69E2E'
          default:
            return '#718096'
        }
      }}
      nodeRelSize={6}
      linkColor={() => '#CBD5E0'}
      linkWidth={1}
      onNodeClick={handleNodeClick}
      d3VelocityDecay={0.3}
      d3AlphaDecay={0.02}
      cooldownTime={3000}
    />
  )
}
