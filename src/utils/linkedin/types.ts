import type { Database } from '../supabase/types';

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type ProfileInsert = Database['public']['Tables']['profiles']['Insert'];
export type ProfileUpdate = Database['public']['Tables']['profiles']['Update'];

export interface LinkedInProfile {
  firstName: string;
  lastName: string;
  emailAddress?: string;
  position?: string;
  linkedinSlug: string;
}

export interface LinkedInConnection {
  firstName: string;
  lastName: string;
  emailAddress?: string;
  position?: string;
  company?: string;
  linkedinSlug: string;
  connectedOn?: string;
}

export interface LinkedInPosition {
  title: string;
  company: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface LinkedInEducation {
  school: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

export interface LinkedInSkill {
  name: string;
}

export interface ProcessedLinkedInData {
  profile: LinkedInProfile;
  connections: LinkedInConnection[];
  positions?: LinkedInPosition[];
  education?: LinkedInEducation[];
  skills?: LinkedInSkill[];
}
