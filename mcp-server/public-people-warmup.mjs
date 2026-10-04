import { createPublicPeopleReader } from '../src/utils/public-people/reader.mjs'

// Populate the same process-local index used by subsequent public requests.
// Only content-addressed public sources can reuse it; never warm a viewer's
// private projection. The reader bounds the work and aborts slow providers.
export async function warmPublicPeopleIndex({ readPublishedSnapshot, timeoutMs = 8000 } = {}) {
  if (typeof readPublishedSnapshot !== 'function' || readPublishedSnapshot.revisionIdentifiesContent !== true) return false
  try {
    await createPublicPeopleReader({ readPublishedSnapshot, timeoutMs }).list()
    return true
  } catch {
    // An unavailable publication must not prevent login or other routes from
    // starting. Normal requests retry through their live publication checks.
    return false
  }
}
