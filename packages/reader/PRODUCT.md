# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers working across registered source checkouts who read the documentation resources attached to one Tack project while building. Their recurring job is to understand a document, then hand precise, source-referenced context to a coding agent.

## Product Purpose

`tack docs serve` serves the healthy registered docs resources of one project on localhost. It supports ordinary Markdown and MDX, makes working documents comfortable to read, and turns a block, section, selection, or interactive visual state into prompt-ready copy with physical file, line, and source-resource references.

## Positioning

Every rendered block knows its physical source range, source resource, and version. Copies cite saved files (not generated Markdown), include visual state, and are refused when stale.

## Operating Context

Runs beside an editor and a coding agent on the same machine, often for long sessions, in light or dark system appearance. Documents are authored in registered source checkouts; the browser only changes viewing state. Saved edits in every attached source live-reload the reader. "Open in editor" offers Zed, Cursor, and VSCode in that order and remembers the last selection in the browser.

## Capabilities and Constraints

- Rspress compiles Markdown and MDX and owns routing; Tack supplies separate source-qualified navigation roots, shared search, metadata filters, outline, copy controls, and the figure catalog.
- Copy formats: readable + sources, raw source, references only; optional component implementation context.
- Source-local customization modules may supply Navigation, layouts and components for their own resource. The reader provides React, React DOM, `@tackup/reader` and Rspress to them, so a source component can use a portal without a second copy of React.
- Static source-load failures show an explicit diagnostic while healthy resources remain readable and searchable. A source module that only throws during browser evaluation is isolated in its presentation slot and does not change the static corpus or search results.
- Metadata vocabularies (working-docs preset): types walkthrough, explanation, reference, decision, spec, note; statuses draft, review, accepted, active, complete, superseded.
- No network dependencies at runtime beyond localhost. Frontend dependencies are fixed: `@base-ui/react` supplies the interactive parts (popovers, the editor and copy format menus, the figure Expand dialog, the narrow-viewport documents drawer, tooltips), imported per component and styled with the reader's Tailwind tokens; `lucide-react` supplies interface glyphs, imported by name and drawn through the reader's `Glyph` wrapper, and the curated docs icon set documents draw with `<Icon name>`, bundled per generation from the names they use; figures may add only `elkjs`, to compute box positions for `System` and `Schema` and loaded only on a page that has one. Simple toggles, buttons and selects stay native. `acorn` is a server-side dependency of the figure check, never shipped to the browser.

## Figures

- A figure proves one claim. Its caption ("Fig. N" and the claim) and summary are text on the page: a figure is not a filled card. The drawing's ground is its only filled area.
- Authors write meaning (tiers, boxes, links, steps, values); the reader owns every position, size and colour. Geometry derives from counts and character-width estimates, never from measuring, so the page and `tack check` agree.
- The ground depends on the figure kind, as a default the reader picks: quad-ruled paper for architecture and systems, ruled lines for trees, a dot grid for schemas, none for steps and quantities. These choices, the box radius (3 px) and stroke, and the card fill live in `src/figures/look.ts`.
- Hue appears in figures as six quiet tints (amber, teal, purple, olive, rust, grey), picked by the component in order, and always redundant with position. Only an authored figure, which places its own boxes, picks a tint by number. Blue stays the viewer's own hand (focus, pin, the current replay step); red stays for warnings and broken things. Tints never use either.
- Dense drawings show no links at rest; focus shows a box's links, and a box with more than 24 links in one direction shows one bundle per tier.
- Input and layout issues never break a page: the figure renders what it can and lists its issues under itself, in the same lines `tack check` prints.

## Evidence on Hand

Registered project docs resources may live in different source checkouts and can contain overlapping names and folders. The reader preserves physical provenance and source-qualified routes.

## Product Principles

- The document is the subject; tooling is present but quiet until called.
- Source truth over convenience: never imply a citation the reader cannot verify.
- Viewing state is shareable and reproducible (URL, readable copy).
- Explicit over implicit: registered resources, bounded source imports, optional author configuration, no hidden discovery.

## Accessibility & Inclusion

Keyboard-operable controls, visible focus, reduced-motion support, light and dark appearances with WCAG AA contrast.
