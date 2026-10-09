# Click-value previews

On 2026-10-04 Jacob clarified the actual decision: will opening a link reveal any information beyond what is already visible? Profile completeness alone does not answer that.

The interactive comparison in `.lavish/connections-options.html` now shows:

1. **Additional detail:** About · 3 past roles · 24 connections (person), or Overview · 8 people (company).
2. **Network information only:** 12 connections · No additional profile details, or 4 people · No company overview. These destinations remain useful despite limited profile content.
3. **No additional information:** only when the destination has neither extra content nor a connections/people list beyond the visible identity. The hypothetical empty-company example illustrates the cue; it does not claim such a route currently exists in the live runtime.

Option A uses a quiet secondary line that lists what opens. Option B uses a compact hint within the clickable name so the distinction can travel with inline links. Both remain legible, contain no depth icons, retain alphabetical and richer-first sorting, and open fictional destination previews on click.

Implementation must derive click value from actual public destination content relative to the caller’s visible summary. The existing basic/detailed classifier is insufficient on its own: a basic page with a graph neighbourhood must not say no additional information. Unknown/unavailable content must not be labelled as definitely empty. This comparison is a design proposal, not a production change.
