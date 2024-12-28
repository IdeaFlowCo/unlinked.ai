declare module 'react-force-graph' {
  import { Component } from 'react'
  import { Simulation, SimulationNodeDatum } from 'd3-force'
  
  export interface NodeObject<NodeData = unknown> extends SimulationNodeDatum {
    id?: string
    x?: number
    y?: number
    vx?: number
    vy?: number
    fx?: number | null
    fy?: number | null
    __indexColor?: string
    [key: string]: string | number | null | undefined
  }
  
  export interface LinkObject<NodeData = unknown, LinkData = unknown> {
    source: string | number | NodeObject<NodeData>
    target: string | number | NodeObject<NodeData>
    [key: string]: string | number | NodeObject<NodeData> | undefined
  }
  
  export interface GraphData<NodeData = any, LinkData = any> {
    nodes: NodeObject<NodeData>[]
    links: LinkObject<NodeData, LinkData>[]
  }
  
  export interface ForceGraphProps<NodeData = any, LinkData = any> {
    graphData: GraphData<NodeData, LinkData>
    nodeId?: string
    linkSource?: string
    linkTarget?: string
    nodeLabel?: string | ((node: NodeObject<NodeData>) => string)
    nodeVal?: number | ((node: NodeObject<NodeData>) => number)
    nodeRelSize?: number
    nodeColor?: string | ((node: NodeObject<NodeData>) => string)
    nodeAutoColorBy?: string | ((node: NodeObject<NodeData>) => string | null)
    linkLabel?: string | ((link: LinkObject<NodeData, LinkData>) => string)
    linkVisibility?: boolean | ((link: LinkObject<NodeData, LinkData>) => boolean)
    linkColor?: string | ((link: LinkObject<NodeData, LinkData>) => string)
    linkWidth?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalArrowLength?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalArrowColor?: string | ((link: LinkObject<NodeData, LinkData>) => string)
    linkDirectionalArrowRelPos?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalParticles?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalParticleSpeed?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalParticleWidth?: number | ((link: LinkObject<NodeData, LinkData>) => number)
    linkDirectionalParticleColor?: string | ((link: LinkObject<NodeData, LinkData>) => string)
    dagMode?: string
    dagLevelDistance?: number
    dagNodeFilter?: (node: NodeObject<NodeData>) => boolean
    onNodeClick?: (node: NodeObject<NodeData>, event: MouseEvent) => void
    onNodeRightClick?: (node: NodeObject<NodeData>, event: MouseEvent) => void
    onNodeHover?: (node: NodeObject<NodeData> | null, previousNode: NodeObject<NodeData> | null) => void
    onLinkClick?: (link: LinkObject<NodeData, LinkData>, event: MouseEvent) => void
    onLinkRightClick?: (link: LinkObject<NodeData, LinkData>, event: MouseEvent) => void
    onLinkHover?: (link: LinkObject<NodeData, LinkData> | null, previousLink: LinkObject<NodeData, LinkData> | null) => void
    width?: number
    height?: number
    backgroundColor?: string
    showNavInfo?: boolean
    nodeCanvasObject?: (node: NodeObject<NodeData>, ctx: CanvasRenderingContext2D, globalScale: number) => void
    nodeCanvasObjectMode?: string | ((node: NodeObject<NodeData>) => string)
    linkCanvasObject?: (link: LinkObject<NodeData, LinkData>, ctx: CanvasRenderingContext2D, globalScale: number) => void
    linkCanvasObjectMode?: string | ((link: LinkObject<NodeData, LinkData>) => string)
    enableNodeDrag?: boolean
    enableZoomPanInteraction?: boolean
    enablePointerInteraction?: boolean
    d3AlphaDecay?: number
    d3VelocityDecay?: number
    warmupTicks?: number
    cooldownTicks?: number
    cooldownTime?: number
    onEngineStop?: () => void
    onEngineTick?: () => void
    d3Force?: string | ((force: Simulation<NodeObject<NodeData>, undefined>) => void)
  }
  
  export class ForceGraph2D<NodeData = any, LinkData = any> extends Component<ForceGraphProps<NodeData, LinkData>> {}
  export class ForceGraph3D<NodeData = any, LinkData = any> extends Component<ForceGraphProps<NodeData, LinkData>> {}
  export class ForceGraphVR<NodeData = any, LinkData = any> extends Component<ForceGraphProps<NodeData, LinkData>> {}
  export class ForceGraphAR<NodeData = any, LinkData = any> extends Component<ForceGraphProps<NodeData, LinkData>> {}
}
