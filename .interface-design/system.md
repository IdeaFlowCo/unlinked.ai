# Unlinked browser UI

Preserve the existing Public Sans typography, compact profile cards, indigo
accent and native controls. Light page #f5f6fc; white cards; indigo #4349c4.
Dark page #11141d; cards #1b202c; inset/secondary surfaces #252b39; indigo
buttons #5961d6 with white text; links #b2b9ff. Use the semantic tokens in
`mcp-server/appearance.mjs` for all colors. Borders and subtle surface changes
establish depth; avoid strong dark shadows. Colored profile initials and
photos retain their colors; QR canvases stay white.

Keep the established 4px spacing base, 8px control radius, 12px panels, and
Public Sans 14px/16px controls with 600 weight for labels/actions.

Appearance: quiet 44px half-circle summary in the shared header; native
System/Light/Dark selector inside a 240px panel, 16px padding, 12px radius.
On phones the appearance trigger shares the logo row; navigation and search
keep their own rows. Panel and selector use semantic surface/text/focus tokens.
The default is System; explicit overrides are device-local. See docs/appearance.md.
