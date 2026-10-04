# Profile connection browsing and page depth

Browser profiles link to `/people/<id>/connections`, a public-only, native GET view. It browses all published connections in either direction with bounded server pagination. Search (`q`, at most 200 characters) matches all meaningful words within that person’s connections. `sort=detail` is the browser default; `sort=name` preserves alphabetical browsing. Each cursor is bound to profile, normalized search, sort and publication revision. Merged addresses preserve the view and search on redirect.

The shared reader adds `detailLevel: basic | detailed` to public summaries and details. Depth is derived only from public fields, independently of membership, photos and connection counts. An about section, meaningful education or skills, multiple meaningful positions, or dated/described experience means detailed. A name, headline and one undated company/title entry remain basic. Detailed means additional information, not complete or verified information. Profile details also return `connectionCount` and `connectionsTotal` (after filtering).

Basic person links have a muted page-outline icon with screen-reader text. The connections view includes a visible legend for touch users. Destinations explain their limited information in one quiet sentence. Company experience links use the same cue, based on the same published facts used by their destinations. All links remain usable and legible.

`.lavish/connections-options.html` contains two interactive alternatives using Unlinked’s existing Public Sans, slate, indigo and white-panel styling, with fictional data. A is the implemented continuous list with quiet page cues. B is a design alternative: headings in detail order, page cues in alphabetical order. No production design selection has been inferred from the comparison.

Gemini 2.5 Pro reviewed both via Vertex on 2026-10-03. It preferred A with a semantic page icon and visible legend over an arbitrary circle. Its proposed alternative combines B’s grouped default with A’s cues in other sort orders. The complete second opinion is in `connection-design-second-opinion.md`.
