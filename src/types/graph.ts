import type { Database } from '../utils/supabase/types'

export type Profile = Database['public']['Tables']['profiles']['Row']
export type Company = Database['public']['Tables']['companies']['Row']
export type Institution = Database['public']['Tables']['institutions']['Row']

export type Node = {
  id: string | number
  name: string
  type: 'person' | 'company' | 'institution'
  __data?: Profile | Company | Institution
}
