import { z } from 'zod'

const text = z.string().max(20000)
export const summarySchema = z.object({ id: z.string().min(1).max(160).refine(id => id !== '.' && id !== '..'), name: text.min(1), headline: text.optional(), location: text.optional(), detailLevel: z.enum(['basic', 'detailed']).optional() })
export const listingSchema = z.object({ profiles: z.array(summarySchema).max(100), nextCursor: z.string().max(2048).optional() })
export const detailSchema = z.object({ profile: summarySchema.extend({
  about: text.optional(), company: text.optional(), industry: text.optional(), linkedinUrl: text.optional(), website: text.optional(),
  positions: z.array(z.object({ title: text, company: text, startDate: text.optional(), endDate: text.optional(), description: text.optional() })).max(100),
  education: z.array(z.object({ institution: text, degree: text.optional(), startDate: text.optional(), endDate: text.optional() })).max(100),
  skills: z.array(text).max(500), connections: z.array(summarySchema).max(100), nextConnectionsCursor: z.string().max(2048).optional(),
}) })
export type PublicPerson = z.infer<typeof summarySchema>
export type PublicProfile = z.infer<typeof detailSchema>['profile']
export type DirectoryResult<T> = { state: 'ready'; data: T } | { state: 'unavailable' } | { state: 'not-found' }

// Integration stays unavailable until the runtime owner supplies a public-only reader.
// A reader must never project owner-private imported rows into this interface.
export interface PublicDirectoryReader {
  list(input: { query: string; cursor?: string }): Promise<unknown>
  profile(input: { id: string; cursor?: string }): Promise<unknown | null>
}
export function createDirectory(reader?: PublicDirectoryReader) {
  return {
    async list(query: string, cursor?: string): Promise<DirectoryResult<z.infer<typeof listingSchema>>> {
      if (!reader) return { state: 'unavailable' }
      try { const parsed = listingSchema.safeParse(await reader.list({ query: query.slice(0, 200), cursor })); return parsed.success ? { state: 'ready', data: parsed.data } : { state: 'unavailable' } } catch { return { state: 'unavailable' } }
    },
    async profile(id: string, cursor?: string): Promise<DirectoryResult<PublicProfile>> {
      if (!reader) return { state: 'unavailable' }
      try { const value = await reader.profile({ id, cursor }); if (value === null) return { state: 'not-found' }; const parsed = detailSchema.safeParse(value); return parsed.success ? { state: 'ready', data: parsed.data.profile } : { state: 'unavailable' } } catch { return { state: 'unavailable' } }
    },
  }
}
export const directory = createDirectory()
