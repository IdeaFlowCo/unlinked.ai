declare module 'react-force-graph' {
  import { Component } from 'react'
  import { Simulation, SimulationNodeDatum } from 'd3-force'
  
  export interface NodeObject extends SimulationNodeDatum {
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
  
  export interface LinkObject {
    source: string | number | NodeObject
    target: string | number | NodeObject
    [key: string]: string | number | NodeObject | undefined
  }
  
  export interface GraphData {
    nodes: NodeObject[]
    links: LinkObject[]
  }
  
  export interface ForceGraphProps {
    graphData: GraphData
    nodeId?: string
    linkSource?: string
    linkTarget?: string
    nodeLabel?: string | ((node: NodeObject) => string)
    nodeVal?: number | ((node: NodeObject) => number)
    nodeRelSize?: number
    nodeColor?: string | ((node: NodeObject) => string)
    nodeAutoColorBy?: string | ((node: NodeObject) => string | null)
    linkLabel?: string | ((link: LinkObject) => string)
    linkVisibility?: boolean | ((link: LinkObject) => boolean)
    linkColor?: string | ((link: LinkObject) => string)
    linkWidth?: number | ((link: LinkObject) => number)
    linkDirectionalArrowLength?: number | ((link: LinkObject) => number)
    linkDirectionalArrowColor?: string | ((link: LinkObject) => string)
    linkDirectionalArrowRelPos?: number | ((link: LinkObject) => number)
    linkDirectionalParticles?: number | ((link: LinkObject) => number)
    linkDirectionalParticleSpeed?: number | ((link: LinkObject) => number)
    linkDirectionalParticleWidth?: number | ((link: LinkObject) => number)
    linkDirectionalParticleColor?: string | ((link: LinkObject) => string)
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
    d3Force?: string | ((force: Simulation<NodeObject, undefined>) => void)
  }
  
  export class ForceGraph2D extends Component<ForceGraphProps> {}
  export class ForceGraph3D extends Component<ForceGraphProps> {}
  export class ForceGraphVR extends Component<ForceGraphProps> {}
  export class ForceGraphAR extends Component<ForceGraphProps> {}
}
