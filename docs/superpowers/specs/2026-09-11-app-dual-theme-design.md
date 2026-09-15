# Application Dual Theme Design

## Status

Ready for review.

## Goal

Give Conflux a coherent application-wide light and dark theme. The light
"workbench" theme remains the default visual language; the dark "terminal"
theme provides the Coding Agent-like reading environment requested for channel
conversations without making only one panel look different from the rest of
the product.

## Product Decisions

- The setting has three values: `system`, `light`, and `dark`.
- `system` is the default and follows the operating system's color preference.
- Theme is a browser-local preference, stored in `localStorage`. It is a
  personal reading preference and must not be shared through the server
  database with other users or sessions.
- The active theme is applied to the document before React renders, avoiding a
  flash of the opposite theme on page load.
- When the preference is `system`, a `prefers-color-scheme` change updates the
  application without a reload.
- Settings exposes a compact segmented control with the three choices. It uses
  text labels because each option is a persistent user preference, not a
  transient tool action.

## Visual Language

Theme values are CSS custom properties on the root theme attribute. Components
consume semantic values rather than hard-coded gray, blue, and white classes.

| Semantic token | Light workbench | Dark terminal |
| --- | --- | --- |
| Application canvas | cool off-white | near-black navy |
| Raised surface | white | blue-black |
| Divider | pale blue-gray | muted steel |
| Primary focus / selected channel | blue | cyan |
| Question bubble | saturated blue with white text | dark cyan with pale cyan text |
| Reply bubble / reply marker | white and emerald | deep green and mint |
| Muted text | neutral gray | blue-gray |
| Error / warning / live status | preserve existing semantic hue and meet contrast | preserve semantic hue with a brighter dark-mode value |

The dark theme is not a literal color inversion. It retains the same hierarchy
and role meanings: blue/cyan identifies the initiating question and selected
channel, green identifies a reply, amber identifies attention, and red
identifies failure.

## Surface Coverage

The theme applies consistently to:

- Application shell, sidebar, navigation active and hover states.
- Graph canvas, controls, minimap, background grid, nodes, labels, selected
  edges, dimmed edges, arrows, and endpoint emphasis.
- Detail panels, tabs, lists, settings controls, empty states, borders,
  tooltips, dialogs, inputs, buttons, and status badges.
- Channel headers, message metadata, question bubbles, reply bubbles, pending
  indicators, Markdown code blocks, tables, and links.

Message direction remains unchanged: the channel initiator's question is
right-aligned; its reply is left-aligned and explicitly marked as a reply.

## Architecture

1. A small web-only theme module owns preference parsing, system resolution,
   root attribute updates, and subscription to system changes.
2. `index.html` runs a minimal, dependency-free boot script that resolves the
   saved preference and sets `data-theme="light"` or `data-theme="dark"` before
   the application stylesheet is painted.
3. The React application reads the same module for the Settings control and
   updates the root attribute immediately when the user selects an option.
4. `index.css` defines global semantic variables for each root attribute.
   Existing component styles migrate only where a hard-coded color prevents
   the component from adapting.
5. React Flow receives its dark-mode colors through the same variables and
   its documented theme class/props, so the graph remains readable rather than
   inheriting browser defaults.

No server route, database migration, or MCP/CLI behavior changes are required.

## States And Edge Cases

- Missing, malformed, or obsolete `localStorage` values resolve to `system`.
- If `matchMedia` is unavailable, `system` resolves to light.
- A manually selected light or dark theme ignores subsequent system changes.
- A system-theme user sees the new resolved color immediately after their OS
  switches appearance.
- The selected edge and selected graph endpoint retain stronger contrast than
  ordinary graph elements in both themes.
- Theme choice does not alter persisted graph positions, selected sessions,
  channels, or message ordering.

## Verification

- Unit-test preference normalization and system-resolution behavior, including
  malformed storage values and `matchMedia` changes.
- Add a focused settings interaction test: choosing each of the three options
  persists the preference and updates the root theme attribute.
- Extend graph builder/component coverage where selected and dimmed edge
  colors are now token-driven.
- Build the web workspace and manually inspect both themes at desktop and
  narrow widths, including graph selection, a pending channel message, a
  replied message containing Markdown code, an empty detail panel, and the
  Settings page.

## Out Of Scope

- Per-panel themes, per-channel themes, arbitrary color pickers, and a
  separate high-contrast accessibility theme.
- Changing server-side session, message, or channel storage.
