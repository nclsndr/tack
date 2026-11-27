# @tackup/reader

`@tackup/reader` renders and searches the docs resources attached to one Tack project. It is a
private workspace package that `tack docs serve` and `tack docs search` run. How to declare, attach,
write and configure docs is on the website:
[Docs and the reader](https://tackup.dev/docs/reference/docs). The figure components are taught by
the built-in `write-reader-figures` skill.

The CLI resolves the selected project, its registered sources and missing attachments. It passes the
same `ReaderProjectInput` to the browser server and the search loader, so navigation, search,
provenance and unavailable-resource reporting agree.

Each resource is identified by its source registration ID and docs name. Its route
is `/docs/<sourceRegistrationId>/<name>/<resource-relative-path>` with the document extension
removed. A document retains its physical saved `path`; `relativePath` is relative to its docs resource. Two sources can therefore
publish `architecture.md` without merging navigation, search hits, copy citations, or custom UI.

## Figures

The standard components include the figure catalog: `ArchitectureMap`, `System`, `Schema`,
`FileTree`, `Walkthrough`, `Chart` and the authored `Figure`. Every figure shares one frame
(caption, summary, controls, drawing on its ground, panel, legend, issue list) and keeps its view
state in the URL and its text equivalent in copy and search. `System` and `Schema` place their boxes
with `elkjs`, loaded in its own chunk only on a page that has one; the kit draws every link, and a
`Schema` relation ends on the row of its column. The contracts the `write-reader-figures` skill's
reference is generated from are in [`src/figures/reference.ts`](src/figures/reference.ts), and the
look settings (card fill, box radius and stroke, ruled pitch, ground per figure kind) in
[`src/figures/look.ts`](src/figures/look.ts).

## Icons

The docs icon set is one generated file,
[`src/icons/catalog.generated.ts`](src/icons/catalog.generated.ts), written from
[`src/icons/curated.ts`](src/icons/curated.ts) and the installed `lucide-react` by
`bun run icons:catalog`. A test fails until the file matches both, so a Lucide upgrade that renames
or drops a curated icon fails until the list is fixed. From that file come the `DocsIconName` type,
the names `tack check` validates, the same messages in the reader's issue popover, and
`tack docs icons`. Each reader generation bundles only the icons its documents and their component
modules name, one Lucide module each, which is why names must be plain strings.

## Author components

`Callout`, `Tabs`, `Tab` and `Term` are built on Base UI. `checkDocumentComponents(source, path)` in
[`src/authoring/check.ts`](src/authoring/check.ts) finds each misuse by line; `tack check` and the
issue popover report it.

## Source modules and failures

The loader preflights configured modules and direct MDX imports with Bun. A module that only throws
when the browser evaluates it is not executed during corpus loading, so it remains searchable; its
source-qualified presentation is isolated in the reader with an actionable error while other
documents remain usable. A source's own modules and MDX are not scanned for Tailwind classes: the
reader styles the token classes listed in [`src/figures/tokens.ts`](src/figures/tokens.ts) instead.

## Browser reader

The reader shows one project view. Its index has separate labeled roots for each source/docs
resource, while search and metadata filters work across the healthy project corpus. Document
headers, search hits, and every copy format show source provenance. The mobile header uses a
readable source/docs label and keeps the full physical path and source ID in its tooltip.

The sidebar header names the project: a two-letter monogram (the first and last letter or digit of
the project name, one letter for a one-letter name) and the name, over the branch the project root
has checked out, or the short commit of a detached head. Outside git, the second line shows the
root folder name instead; a project or source need not be a git repository. The header opens a
popover with the branch, the root, each attached docs resource with its document count and docs
folder, the live state and the Tack release the CLI passed in.

Skipped documents and unavailable resources live in one place: the bottom-right issue popover. Its
closed state counts them (`1 doc skipped · 1 resource unavailable`); opened, it lists each by file
or resource with the first clause of its cause, and the full message on hover. A failed rebuild
joins that list. The header keeps only a small red mark while any issue is open, and healthy
documents remain open. `/__tack/corpus` carries `documents`, `issues`, `complete`, a revision, and
the session token; it rebuilds the corpus on each request and is a diagnostic, not the page's
change check. `complete` is true exactly when the project has no resource issues, including
backend-provided missing-attachment issues. Saved edits to every source checkout are watched,
including currently broken resources. Inline settings, YAML links, and linked file edits reload
without restarting. Changing the registered project, its attachments, or the
selected resource catalog requires restarting the reader session.

The reader's interactive parts use [Base UI](https://base-ui.com) components styled with the
reader's Tailwind tokens: the header and issue popovers, the editor menu, the copy split button's
format menu, the figure Expand dialog, the narrow-viewport documents drawer and the tooltips of icon-only controls. Every popup but
a tooltip moves focus in when it opens and back to its trigger on Escape. The Expand dialog and the drawer are
modal: focus stays inside, and the page behind them leaves the accessibility tree. Floating parts
render inside the reader root, and the Expand dialog inside its figure, so the reader's styles
apply. Interface glyphs are Lucide icons imported by name and drawn through the `Glyph` wrapper in
`src/glyph.tsx`.

The open page checks `/__tack/status` one second after its previous check settles. The status is
`{ revision, error, checkout }`: the revision of the compiled generation being served, the message
of a failed rebuild (empty otherwise; the served generation's own issues arrive in its boot
payload) and the project root's checkout, re-read from git's `HEAD` file on every check without
spawning git, so a branch switch shows without a rebuild. `checkout` is `null` outside git. An
`ETag` turns an unchanged check into an empty `304`. The page reloads only when the revision
changes.
Sidebar rows and Markdown links to reader pages open through the Rspress client router, so the
reader stays loaded between documents. External, download, new-tab, same-page fragment and
modified clicks keep ordinary browser behavior.

## Copy and search

Each block is anchored to its physical saved path and one-based line range. Copy requests include
the active resource identity so stale-copy checks cannot select the same physical block from a
different declaration. Readable, raw, and references-only copy cite the source resource and file.
The header's copy control is a split button: the primary part copies the text selection, and its
chevron opens a menu of the three formats, each with a one-line description and a check on the
current one, plus the component implementation toggle. The choice applies to every copy.
The corpus revision includes document provenance and resource issues.

`@tackup/reader/search` exposes the server-side corpus loader. `@tackup/reader/search-core` exposes
browser-safe matching and `resourceIdentity`. Search text includes source registration ID,
resource name, physical source path, paths, metadata, and authored readable text. Results rank
by weighted title, heading, and body matches. Ties are ordered by resource-relative path, then resource identity. See [search implementation](src/search.ts) and the
[search reference](https://tackup.dev/docs/reference/docs#search) for flags, limits, and result fields.

The public server API is project-oriented:

```ts
import { startReader } from "@tackup/reader/server";
await startReader({ input, port: 0, open: false });
```

`input` is a required `ReaderProjectInput`; command-line fallback belongs to the backend that
resolves registered project state.

## Develop with the example docs

[`examples/atlas`](examples/atlas) is a fake project whose docs exercise every part of the reader:
both popovers, the editor menu, the copy format menu, the drawer, every figure component, a `tree`
fence, an archive shelf, a second docs resource, a draft that does not compile and an unavailable
resource. Serve it with the real reader on its own port (4317 unless `--port` says otherwise):

```sh
bun run reader:example --port 43217
```

[`examples/example.ts`](examples/example.ts) builds the project input the CLI would pass, and
`examples/example.test.ts` keeps the set healthy: the expected pages, exactly its two deliberate
issues and every figure free of issues.
