declare module 'react-force-graph-2d' {
  import { Component } from 'react'
  import { ForceGraphMethods } from 'react-force-graph'

  export interface ForceGraph2DProps {
    graphData: {
      nodes: Array<{
        id: string | number;
        [key: string]: any;
      }>;
      links: Array<{
        source: string | number;
        target: string | number;
        [key: string]: any;
      }>;
    };
    nodeLabel?: string | null | ((node: any) => string | null);
    nodeColor?: string | ((node: any) => string);
    nodeRelSize?: number;
    linkColor?: string | ((link: any) => string);
    linkWidth?: number;
    onNodeClick?: (node: any, event: MouseEvent) => void;
    onNodeHover?: (node: any | null, previousNode: any | null) => void;
    width?: number;
    height?: number;
    d3VelocityDecay?: number;
    d3AlphaDecay?: number;
    cooldownTime?: number;
    d3Force?: (forceName: string) => any;
  }

  export default class ForceGraph2D extends Component<ForceGraph2DProps> implements ForceGraphMethods {}
}
