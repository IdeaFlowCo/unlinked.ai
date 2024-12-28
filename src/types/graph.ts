import type { NodeObject as ForceGraphNode } from 'react-force-graph'
import type { Database } from '../utils/supabase/types'

export type { ForceGraphNode as NodeObject }

export type Profile = Database['public']['Tables']['profiles']['Row']
export type Company = Database['public']['Tables']['companies']['Row']
export type Institution = Database['public']['Tables']['institutions']['Row']

// Base type that matches ForceGraphNode's index signature
export type BaseNode = ForceGraphNode & {
  id: string | number
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

// Our custom node properties
export type CustomNode = {
  name: string
  type: 'person' | 'company' | 'institution'
}

// Combined Node type that satisfies both NodeObject and our needs
export type Node = BaseNode & CustomNode

// Type for internal use with profile data
export type NodeWithData = Node & {
  __data?: Profile | Company | Institution
}

export type Link = {
  source: string | number | Node
  target: string | number | Node
  type: 'connection' | 'position' | 'education'
  [key: string]: string | number | Node | undefined
}

export type CustomGraphData = {
  nodes: Node[]
  links: Link[]
}
