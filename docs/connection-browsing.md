# Profile connection browsing and page depth

Browser profiles link to `/people/<id>/connections`, a public-only, native GET view. It browses all published connections in either direction with bounded server pagination. Search (`q`, at most 200 characters) matches all meaningful words within that person’s connections. `sort=detail` is the browser default; `sort=name` preserves alphabetical browsing. Each cursor is bound to profile, normalized search, sort and publication revision. Merged addresses preserve the view and search on redirect.

## Profile sidebar filter

The profile page's connections sidebar (`#connections`) has a filter field (`q`) and a segmented control: **All**, **You both know** (`show=known`) and **On Unlinked** (`show=members`). Each option shows its count within the current search. The full `/people/<id>/connections` view accepts the same `show` and carries it through "See all". Everything works as a native GET form and links. With JS, `PROFILE_CONNECTIONS_SCRIPT` (`mcp-server/network-filter-script.mjs`) replaces only the sidebar card after a 300 ms pause in typing, and `history.replaceState` keeps the URL shareable.

"You both know" is the profile's connections that are also in the signed-in viewer's published connections. It uses the same per-viewer set (`knownPeople`, 5-minute cache) that header suggestions use to mark "You know". It is offered only to a signed-in viewer on someone else's profile. Only `show=known` waits for a first read of that set, and that wait is bounded; other page views never wait and show the count once the set is cached. When signed out, or when the set can't be read, `show=known` falls back to All. Cursors are bound to `show`, and for `known` to a hash of the viewer's set, so one narrowing never pages another.

The shared reader adds `detailLevel: basic | detailed` to public summaries and details. Depth is derived only from public fields, independently of membership, photos and connection counts. An about section, meaningful education or skills, multiple meaningful positions, or dated/described experience means detailed. A name, headline and one undated company/title entry remain basic. Detailed means additional information, not complete or verified information. Profile details also return `connectionCount` and `connectionsTotal` (after filtering).

Basic person links have a muted page-outline icon with screen-reader text. The connections view includes a visible legend for touch users. Destinations explain their limited information in one quiet sentence. Company experience links use the same cue, based on the same published facts used by their destinations. All links remain usable and legible.

`.lavish/connections-options.html` contains two interactive alternatives using Unlinked’s existing Public Sans, slate, indigo and white-panel styling, with fictional data. A is the implemented continuous list with quiet page cues. B is a design alternative: headings in detail order, page cues in alphabetical order. The spend-limit recovery continues with A, matching the implemented feature and Gemini’s recommendation. Both alternatives remain available for later feedback.

Gemini 2.5 Pro reviewed both via Vertex on 2026-10-03. It preferred A with a semantic page icon and visible legend over an arbitrary circle. Its proposed alternative combines B’s grouped default with A’s cues in other sort orders. The complete second opinion is in `connection-design-second-opinion.md`.

## Hover cards

On a fine pointer (mouse or trackpad), resting 400 ms on any `/people/<id>` link shows a hover card. It has the photo, name, headline, location and connection count, plus "On Unlinked" for members. A signed-in viewer also sees **N mutual connections** (from the same known-people set as "You both know") and their connection state. For members it shows **Message** (`/messages?profile=…`, which the dock opens as a chat window) and **Connect** (a native form POST with the page's CSRF token). The card stays open while the pointer moves onto it. Leaving it, scrolling or pressing Escape closes it. Touch and keyboard keep plain links.

Data comes from `GET /api/people/<id>/card` (`reader.card`). The response is `no-store, private`, with its own budget (600/min, 8 in flight), so hovering never spends the public page budget. Signed out, it returns public summary fields only. The client is `HOVER_CARD_SCRIPT` (`mcp-server/hover-card.mjs`), cached per page.
