# Header autocomplete

Every standalone-runtime page enhances the existing GET `/network?q=…` search form with people, company and navigation suggestions. The layout uses the shared Public Sans typography, indigo tokens and profile avatars. The QR scan control stays beside search.

After two characters and a 220 ms pause, the browser requests `/search-suggestions?q=…`. The public People reader returns at most five people and three distinct companies. Name matches rank ahead of other professional text; exact names and name prefixes get priority. Companies complete against visible position company names, deduplicated without case. Roles, skills and professional text use the directory's existing word matching. No model runs for a keystroke.

This browser-only endpoint accepts only one `q` parameter (up to 200 characters) and uses the published, whitelisted projection for signed-in and anonymous users alike. It does not read a private network, infer an account, or search contact-card data. Responses are `no-store`, and the browser stores no query history. Each request checks the current publication; unavailable data never falls back to private imports. Its separate site-wide budget permits 600 requests per minute and eight in flight without using the full-page budget.

The progressively enhanced combobox supports Arrow Up/Down, Enter, Escape, Tab, click-away and Cmd/Ctrl+K. Focus stays in the input while keyboard selection is announced through `aria-activedescendant`; status and errors are announced politely. IME composition suspends lookup. Requests are canceled on newer input, closing, blur and page exit, with a generation check to reject late responses and a six-second request timeout. The native form and “See all results” remain available when suggestions fail. Without JavaScript the original search and QR links still work.

Verification: `node --test tests/omni-search.test.mjs tests/topbar-me-menu.test.mjs tests/shared-people-browser.test.mjs tests/profile-card.test.mjs`. Browser smoke checks should also cover mobile width, a slow response overtaken by a later query, offline fallback, company/profile navigation and native Enter submission.
