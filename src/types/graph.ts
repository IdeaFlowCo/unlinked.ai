import type { Database } from '../utils/supabase/types'

export type Profile = Database['public']['Tables']['profiles']['Row'] & {
  positions?: Array<Position>;
}

export type Company = Database['public']['Tables']['companies']['Row']
export type Institution = Database['public']['Tables']['institutions']['Row']

export type Position = {
  id: string;
  profile_id: string;
  title: string;
  started_on: string;
  finished_on?: string | null;
  companies?: Company | null;
}

export type Node = {
  id: string | number
  name: string
  type: 'person' | 'company' | 'institution'
  __data?: Profile | Company | Institution
}
