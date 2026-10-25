# Private contact enrichment (unlinked-0ks5)

New connections can be real Unlinked members without a public profile. They
must not be labeled as imports. `/network/contacts/<id>` retains the original
source, connection date and private notes, and shows a richer exact-identity
published profile or a private enrichment when available.

## Flow

In Your people, **Automatically enrich new contacts** opts this viewer in.
The durable worker checks contacts connected or imported within the preceding
14 days, newest first. It resumes after restarts; preferences and results are
private per owner+user. One contact per owner per tick uses the existing shared
provider lease, pacing and daily allowance. Pausing prevents in-flight results
from being saved. A private contact also offers **Find profile details** for an
older contact or a retry.

Exact published profile identity or an existing LinkedIn URL can be enriched
automatically. Names are candidate discovery only, including a single result.
The app first searches published profiles, then the optional private adapter's
`search(name, {signal})`. Only exact normalized full-name matches and canonical
LinkedIn URLs survive; five candidates maximum. The viewer sees company/role,
location and the actual LinkedIn URL, then chooses **Use this profile** or
**None of these**. Confirmation attaches professional details to this viewer's
contact only. It never claims, publishes or edits the other member's identity.
**Know their LinkedIn?** on the contact page lets the viewer paste the
person's LinkedIn address. The viewer's word attaches it to their own contact
only (it needs no opt-in and never proves identity to anyone else), and the
existing bounded URL lookup fills the details. **Remove these details** drops
an attached profile again. This is the path for members who joined without a
published profile (for example by scanning a contact card): their connection
row carries only a name.
Errors, no-match, paused and provider limits remain explicit; there is no
success status without a read-back-able result. The original import is immutable.
The URL lookup and name search share one durable budget; no new credential is
needed when the installed adapter supports name search. Otherwise the page
honestly reports lookup unavailable. Candidate results never contain emails,
phone numbers, raw provider objects or provider IDs.

Every worker completion re-reads the owner's live network and checks the source
fingerprint and preference. Removed contacts, suspended people, deleted owners,
changed sources and concurrent reviews prevent late writes. Version compare-and-set
protects each private record. Account export includes enrichment; account deletion
removes it. Public readers and agent tools do not read this private dataset.

## Interface brief

Intent: Jacob identifying people he just met, calmly, without repeating data entry.
Hierarchy: the person's name first, provenance under their role; the next useful
action follows. Candidates sit in the same contact page above professional history.
Palette: reuse the application's ink, white, muted gray, blue links and semantic
status colors. These fit professional identity and source confidence.
Depth/surfaces: existing card and subtle-border tokens, no additional overlay.
Typography: existing Public Sans; body status and smaller provenance text.
Spacing: existing 4px-based control/card spacing; native forms and buttons retain
keyboard and voice access. No decorative hero, new palette or animation.
Signature: the connection provenance stays separate from “Profile details”; a
suggested LinkedIn match is visibly provisional until the viewer confirms it.
