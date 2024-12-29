import type { ProcessedLinkedInData, Profile, ProfileInsert } from './types';
import { parseLinkedInSlug, processLinkedInData } from './process';
import type { Database } from '../supabase/types';
import { randomUUID } from 'crypto';
import { createClient } from '@/utils/supabase/client';

type DbPosition = Database['public']['Tables']['positions']['Insert'];
type DbEducation = Database['public']['Tables']['education']['Insert'];
type DbSkill = Database['public']['Tables']['skills']['Insert'];

const supabase = createClient();

export async function updateUserProfile(userId: string, profile: ProcessedLinkedInData['profile']) {
  const { error } = await supabase
    .from('profiles')
    .update({
      first_name: profile.firstName,
      last_name: profile.lastName,
      headline: profile.position,
      linkedin_slug: profile.linkedinSlug,
    })
    .eq('id', userId);

  if (error) throw error;
}

export async function createOrUpdateShadowProfile(connection: ProcessedLinkedInData['connections'][0]) {
  const connectionSlug = connection.linkedinSlug;
  if (!connectionSlug) return null;

  // Check for existing profile
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('linkedin_slug', connectionSlug)
    .single() as { data: Database['public']['Tables']['profiles']['Row'] | null };

  if (!existingProfile) {
    // Create new shadow profile
    const { data: newProfile, error } = await supabase
      .from('profiles')
      .insert({
        id: randomUUID(),
        first_name: connection.firstName,
        last_name: connection.lastName,
        headline: connection.position,
        linkedin_slug: connectionSlug,
        is_shadow: true,
      })
      .select()
      .single();

    if (error) throw error;
    return newProfile;
  }

  // Don't update non-shadow profiles
  if (!existingProfile.is_shadow) {
    return existingProfile;
  }

  // Update existing shadow profile if it's missing information
  const { data: updatedProfile, error } = await supabase
    .from('profiles')
    .update({
      first_name: existingProfile.first_name || connection.firstName,
      last_name: existingProfile.last_name || connection.lastName,
      headline: existingProfile.headline || connection.position,
    })
    .eq('id', existingProfile.id)
    .select()
    .single();

  if (error) throw error;
  return updatedProfile;
}

export async function createConnection(userProfileId: string, connectionProfileId: string) {
  // Always store profile IDs in consistent order to prevent duplicates
  const { error } = await supabase
    .from('connections')
    .insert({
      profile_id_a: userProfileId < connectionProfileId ? userProfileId : connectionProfileId,
      profile_id_b: userProfileId < connectionProfileId ? connectionProfileId : userProfileId,
    })
    // Handle conflict using unique constraint
    .select();

  if (error) throw error;
}

export async function processLinkedInUpload(userId: string, files: { name: string, content: string }[]) {
  const data = await processLinkedInData(files);
  if (!data) throw new Error('Failed to process LinkedIn data');

  // Update user's own profile
  await updateUserProfile(userId, data.profile);

  // Process connections
  for (const connection of data.connections) {
    const shadowProfile = await createOrUpdateShadowProfile(connection);
    if (shadowProfile) {
      await createConnection(userId, shadowProfile.id);
    }
  }

  // Process positions if available
  if (data.positions) {
    for (const position of data.positions) {
      const { data: company } = await supabase
        .from('companies')
        .upsert({ name: position.company })
        .select()
        .single();

      if (company) {
        await supabase
          .from('positions')
          .insert({
            profile_id: userId,
            company_id: company.id,
            title: position.title,
            description: position.description || null,
            started_on: position.startDate ? new Date(position.startDate).toISOString() : null,
            finished_on: position.endDate ? new Date(position.endDate).toISOString() : null,
          } satisfies DbPosition);
      }
    }
  }

  // Process education if available
  if (data.education) {
    for (const edu of data.education) {
      const { data: institution } = await supabase
        .from('institutions')
        .upsert({ name: edu.school })
        .select()
        .single();

      if (institution) {
        await supabase
          .from('education')
          .insert({
            profile_id: userId,
            institution_id: institution.id,
            degree_name: edu.degree || null,
            started_on: edu.startDate ? new Date(edu.startDate).toISOString() : null,
            finished_on: edu.endDate ? new Date(edu.endDate).toISOString() : null,
          } satisfies DbEducation);
      }
    }
  }

  // Process skills if available
  if (data.skills) {
    const skillInserts: DbSkill[] = data.skills.map(skill => ({
      profile_id: userId,
      name: skill.name,
    }));

    if (skillInserts.length > 0) {
      await supabase
        .from('skills')
        .insert(skillInserts);
    }
  }
}
