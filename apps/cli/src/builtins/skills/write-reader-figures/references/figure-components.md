# Figure components

Generated from the reader's component contracts. Do not edit by hand.
No prop takes a position, a size or a colour: the reader draws every figure from meaning.

## `ArchitectureMap`

Answers: How is the code organised, what may use what, and which parts does a command pass through?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "CLI architecture". |
| `summary` | No | One or two sentences under the caption, in plain text: Markdown is not rendered there. |
| `rule` | Yes | `{ title, text }`: the one rule that position encodes, such as "Imports point down". |
| `tiers` | Yes | Top to bottom. Each entry is a tier, or an array of two sibling tiers that share one band. |
| `links` | Yes | `{ from, to, label? }`: `from` uses `to`. Each end is a node id or a tier id. Import it from a generated data file when it comes from code. |
| `barriers` | No | `{ between: [tierId, tierId], label }` for two sibling tiers that must not use each other. Drawn as a wall. |
| `startWith` | No | Node ids offered as entry points. Two to four. |
| `replays` | No | `{ id?, label, steps: [{ at: nodeId, note }] }`: a real command or request, step by step. |
| `lenses` | No | `{ id?, label, note, focus: [ids], blocked?: [ids] }`: a named subset in focus, such as a failure or a role. |
| tier | | `{ id, label, path?, note?, nodes }`. `path` and `note` show in the tier's margin. |
| node | | `{ id, label, detail?, about? }`. `detail` is one short line under the label (a path, a role). `about` shows in the panel when the box is pinned. |

What the reader draws:

- Tiers as bands, top to bottom. The margin of a band shows its label, path, note and a `uses` line computed from the links.
- Boxes of one tier share one size and fill balanced rows. A label that repeats the tier path drops it: `features/status` in `features/` prints as `status`.
- Sibling tiers share a band; a barrier draws a wall between them with its label.
- No link at rest. Pointing at a box or focusing it shows its links: uses solid, used by dashed, one further hop muted. Click or Enter pins it.
- A box with more than 24 links in one direction draws one bundle per tier, with a count; the panel lists every link.
- The ground is quad-ruled paper by default.

Budget, checked by `tack check`:

- At most 60 boxes and 8 tier rows.
- At most 12 steps in a replay.
- At most 1,200 px tall at column width.
- A link that points up, or crosses a barrier, is drawn in the warning style and reported.

### Worked example

The plan, five lines kept out of the page:

1. Question: where does code belong in this web app, and what may a page touch?
2. Claim: a page never reads the database; it asks an API route, which owns every query.
3. Form: ArchitectureMap, because the question is what may use what.
4. Parts: the folders of src/ in four tiers; API and jobs as siblings with a barrier.
5. Cases: one replay, placing an order, from the page to the row.

The figure:

```mdx
import { links } from "./web-imports.ts";

<ArchitectureMap
  id="web-architecture"
  title="A page never reads the database: it asks an API route, which owns every query"
  summary="Each box is one folder of src/. The links come from the import graph."
  rule={{ title: "Imports point down", text: "An import points down the map or stays inside its tier." }}
  tiers={[
    { id: "pages", label: "Pages", path: "pages/", note: "what the browser loads", nodes: [
      { id: "pages-home", label: "pages/home" },
      { id: "pages-account", label: "pages/account", detail: "signed in only" },
    ] },
    [
      { id: "api", label: "API", path: "api/", note: "route handlers", nodes: [
        { id: "api-orders", label: "api/orders", about: "The only writer of orders." },
      ] },
      { id: "jobs", label: "Jobs", path: "jobs/", note: "scheduled work", nodes: [
        { id: "jobs-billing", label: "jobs/billing" },
      ] },
    ],
    { id: "data", label: "Data", path: "db/", note: "queries and schema", nodes: [
      { id: "db-orders", label: "db/orders" },
    ] },
  ]}
  barriers={[{ between: ["api", "jobs"], label: "share nothing but the database" }]}
  links={links}
  startWith={["pages-account", "api-orders"]}
  replays={[
    { id: "place-order", label: "Place an order", steps: [
      { at: "pages-account", note: "The form posts to /api/orders." },
      { at: "api-orders", note: "Validates the order and opens a transaction." },
      { at: "db-orders", note: "Inserts the order row." },
    ] },
  ]}
/>
```

## `FileTree`

Answers: What is on disk, what points where, and what is temporary?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. On the fence line or on the wrapper. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". On the fence line or on the wrapper. |
| `summary` | No | One or two sentences under the caption, in plain text: Markdown is not rendered there. |
| `rule` | No | `{ title, text }`: how to read the tree, such as "Arrows are symlinks". Wrapper only. |
| `startWith` | No | Entry ids offered as entry points. Wrapper only. |
| `lenses` | No | `{ id?, label, note, focus?: [entry ids], present?: [entry ids] }`: a moment. `present` names the `[temp]` entries that exist in it; the others are stamped absent. Wrapper only. |
| `source` | No | Never written by hand: the reader fills it from the `tree` fenced block. |
| line | | One entry per line, two spaces per level. `name/` is a directory. `name -> target` is a symlink, resolved from the link's own directory. `# text` is the note. `[key]` emphasises, `[temp]` marks an entry that exists only sometimes, `[12 MB]` is a size. `...` stands for entries left out. |
| entry id | | Its path from the top-level entry: `~/.local/share/tack/current`. A trailing slash is optional. |

What the reader draws:

- Write a fenced block with the language `tree`, in `.md` or `.mdx`, with `id` and `title` on the fence line after the language. Wrap it in `<FileTree>` only for a rule, entry points or lenses.
- One row per entry on ruled lines, names in mono, directories in semibold, key entries boxed, temporary entries dashed.
- A symlink whose target is in the tree gets an arrow in a lane right of every name, ending on the first link its path passes through. Focus on an entry inks it, its chain of links and what points at it.
- Notes in an aligned column, at most two lines. Sizes right-aligned with bars to scale with the largest.
- The ground is ruled-lines by default.

Budget, checked by `tack check`:

- At most 60 entries. Fold the rest into `...`.
- At most 1,200 px tall at column width: about 50 rows.
- Indentation in two spaces; a tab or an odd indentation is reported with its line.

### Worked example

The plan, five lines kept out of the page:

1. Question: after an update, what is on disk, what points at what, what is temporary?
2. Claim: an update swaps one symlink, current; the releases never change.
3. Form: FileTree, because the question is what is on disk.
4. Parts: the bin link, the pointers, one release with its sizes, the temporary entries.
5. Cases: one lens per moment: during an update, after a rollback.

The figure:

````mdx
<FileTree
  id="release-on-disk"
  title="An update swaps one symlink, current; the releases never change"
  rule={{ title: "Arrows are symlinks", text: "An arrow ends where the link resolves on disk." }}
  startWith={["~/.local/bin/tack"]}
  lenses={[
    { label: "During an update", note: "staging/ and update.lock exist until the gate passes.", present: ["~/.local/share/tack/staging/", "~/.local/share/tack/update.lock"] },
    { label: "After a rollback", note: "current points at the older release and hold exists.", present: ["~/.local/share/tack/hold"], focus: ["~/.local/share/tack/current"] },
  ]}
>

```tree
~/.local/
  bin/
    tack -> ../share/tack/current/bin/tack   # created once, never rewritten
  share/tack/
    current -> releases/0.1.0+g1cfcfc7       # the pointer an update swaps [key]
    releases/
      0.1.0+g1cfcfc7/                        # one immutable release [306 MB]
        bin/tack                             # Bun plus the bundled CLI [69 MB]
        node_modules/.bun/                   # production dependencies [237 MB]
        ...
    hold                                     # after a gate failure or a rollback [temp]
    update.lock                              # only during an update [temp]
    staging/                                 # only during an update [temp]
```

</FileTree>
````

## `System`

Answers: Which parts run and what do they send each other? What happens when one fails?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". |
| `summary` | No | One or two sentences under the caption, in plain text: Markdown is not rendered there. |
| `rule` | No | `{ title, text }`: how to read it, such as "Links follow the data". |
| `startWith` | No | Node ids offered as entry points. |
| `nodes` | Yes | The parts that run, and what they touch. Kinds: `service`, `store`, `queue`, `external`, `actor`, `artifact`. |
| `groups` | No | `{ id, label, parent? }`: a boundary such as a host, a network, a trust zone or a process. A group may sit inside one other group. |
| `links` | Yes | `{ id?, from, to, label, kind? }`. The label is required: what moves, or what is done. Kinds: `call`, `async`, `reply` (default `call`). A link points the way the data or the request moves. |
| `replays` | No | `{ id?, label, steps: [{ at: id or [ids], note, broken?: [ids] }] }`. A step names the nodes and links it passes through. |
| `lenses` | No | `{ id?, label, note, focus: [ids], broken?: [ids] }`: a failure, a role or a moment. Ids name nodes and links. |
| node | | `{ id, label, kind, detail?, lines?, about?, group? }`. `detail` is one short line. `lines` are up to 6 mono lines inside the box: table names, sub-parts, settings. `about` shows in the panel when the node is pinned. |

What the reader draws:

- Shapes by kind: a service is a plain box, a store a cylinder, a queue a box with slots, an external part a dashed outline, an actor a pill, an artifact a sheet with a folded corner. The legend lists the shapes in use.
- Groups are labelled regions with a dashed border, tinted in order.
- Every link at rest, as a curve with its label on it. The kind sets the line and never changes: `call` solid, `async` dashed, `reply` dotted. Focus and cases change the ink, not the line.
- Box positions come from a layered layout that respects groups. Left to right when the whole drawing fits the column with text at full size, top to bottom otherwise, then the same with link labels on two lines. A link that would cross a box bows out around it.
- A step or a lens inks the nodes and links it names and fades the rest; broken parts are struck in red and their links end in a stop mark.
- The ground is quad-ruled paper by default.

Budget, checked by `tack check`:

- At most 12 nodes, 6 lines in a node and 12 steps in a replay.
- Every link has a label; every node is in a link.
- Text is never drawn under 11 px. A drawing that fits no way is reported and scrolls sideways; at most 1,200 px tall.

### Worked example

The plan, five lines kept out of the page:

1. Question: how does one parcel event reach the database, and what happens when a part is down?
2. Claim: an event leaves Redis only after Postgres has it.
3. Form: System, because the question is what runs and what it sends.
4. Parts: the feed, the collector in its untrusted worker, the stream, the consumer, Postgres. The backfill job is left out.
5. Cases: a replay of one event, a lens for Postgres down.

The figure:

```mdx
<System
  id="capture-path"
  title="An event leaves Redis only after Postgres has it"
  rule={{ title: "Links follow the data", text: "A link points the way an event moves." }}
  startWith={["redis"]}
  groups={[{ id: "browser", label: "worker-browser (untrusted)" }]}
  nodes={[
    { id: "feed", label: "Carrier tracking feed", kind: "external" },
    { id: "collector", label: "collector", kind: "service", detail: "headless browser + WebSocket", group: "browser" },
    { id: "redis", label: "Redis stream", kind: "queue", detail: "about 1 day at 3 GB" },
    { id: "consumer", label: "worker-core", kind: "service", detail: "consumer" },
    { id: "pg", label: "Postgres", kind: "store", lines: ["public.parcel_events"] },
  ]}
  links={[
    { id: "capture", from: "feed", to: "collector", label: "parcel events" },
    { id: "xadd", from: "collector", to: "redis", label: "XADD" },
    { id: "read", from: "redis", to: "consumer", label: "XREADGROUP" },
    { id: "insert", from: "consumer", to: "pg", label: "INSERT" },
    { id: "ack", from: "consumer", to: "redis", label: "ack + delete", kind: "reply" },
  ]}
  replays={[
    { label: "One event", steps: [
      { at: ["feed", "capture", "collector"], note: "The collector receives the event." },
      { at: ["xadd", "redis"], note: "It waits in the stream." },
      { at: ["read", "consumer", "insert", "pg"], note: "The consumer inserts it." },
      { at: ["ack"], note: "Only then is the entry acknowledged and deleted." },
    ] },
  ]}
  lenses={[
    { label: "Postgres down", note: "Capture continues. Events wait in Redis.", focus: ["collector", "xadd", "redis"], broken: ["pg", "insert"] },
  ]}
/>
```

## `Schema`

Answers: Which tables or entities exist, how do they relate at the level of a column, and which role may read or write what?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". |
| `summary` | No | One or two sentences under the caption, in plain text: Markdown is not rendered there. |
| `rule` | No | `{ title, text }`: how to read it. |
| `startWith` | No | Table names offered as entry points. |
| `tables` | Yes | The tables, or the entities. A dotted name `schema.table` puts the table in the group `schema`; the card drops the prefix. |
| `groups` | No | `{ id, label, note? }` to name and describe a group, such as a Postgres schema. |
| `links` | No | `{ from, to, label, cardinality? }` for a relation that is not a foreign key. Ends are `schema.table.column` or `schema.table`. Cardinalities: `one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`. |
| `lenses` | No | `{ id?, label, note, focus?: [tables], access?: { "<table or schema.*>": level } }`. `focus` shows which tables a concern involves; `access` shows what a role may do to each, a table it does not list is `none`; `write` covers insert, update and delete, so say "insert only" in the note. Levels: `read`, `write`, `read-write`, `none`. |
| `replays` | No | `{ id?, label, steps: [{ at: name or [names], note }] }`. A step names the tables, or `schema.table.column` columns, a query touches, in order. |
| table | | `{ name, note?, columns, unique? }`. `unique` lists column sets that are unique together, such as `[["depot", "observed_at"]]`. |
| column | | `{ name, type?, key?: "pk" | "unique", ref?: "schema.table.column", nullable?, note? }`. A `ref` is a foreign key to a declared table. A table whose columns have no `type` is an entity: give every column a type, or none. |

What the reader draws:

- A card per table: the name, then one row per column with its key mark (PK, FK, UQ), its name, `?` when nullable, its type right-aligned in mono and its note on a second line.
- An entity card is lighter: the name and its attributes, no type column.
- A foreign key is a curve from the row of the referencing column to the row of the referenced column, with a crow's foot at the many end and a bar at the one end. A link that is not a key is dashed and labelled; between entities it is solid, labelled with its verb and marked by its cardinality.
- Groups are labelled regions, tinted in order. Cards are packed to keep the figure short, tables that reference each other near each other, each group as one block.
- Focus on a table inks it, what it references and what references it, and the panel says so column by column.
- An access lens stamps each table with R, W or RW and hatches the tables the role may not touch. A focus lens keeps its tables inked and fades the rest.
- The ground is dot-grid paper by default.

Budget, checked by `tack check`:

- At most 12 tables: split a larger schema by group. At most 12 steps in a replay.
- Every `ref` and link end names a declared table or column; every table has a column; no table is declared twice; SQL tables and entity cards are not mixed.
- Text is never drawn under 11 px. At most 1,200 px tall at column width.

### Worked example

The plan, five lines kept out of the page:

1. Question: which tables hold parcels, how do they join, and who may write them?
2. Claim: every parcel chains back to a depot, and only the collector writes events.
3. Form: Schema, because the question is tables, keys and roles.
4. Parts: depots, parcels, parcel_events and the job log they share a workflow with. auth is left out.
5. Cases: a lens per role, with access.

The figure:

```mdx
<Schema
  id="parcel-schema"
  title="Every parcel chains back to a depot, and only the collector writes events"
  rule={{ title: "A line ends on the column it references", text: "A crow's foot marks the many end." }}
  startWith={["public.parcels"]}
  groups={[{ id: "public", label: "public", note: "application data" }, { id: "ops", label: "ops" }]}
  tables={[
    { name: "public.depots", columns: [
      { name: "code", type: "text", key: "pk", note: "e.g. LYS1" },
      { name: "name", type: "text" },
    ] },
    { name: "public.parcels", columns: [
      { name: "id", type: "bigserial", key: "pk" },
      { name: "depot", type: "text", ref: "public.depots.code" },
      { name: "tracking_code", type: "text" },
      { name: "carrier", type: "text", nullable: true },
    ] },
    { name: "public.parcel_events", columns: [
      { name: "id", type: "bigserial", key: "pk" },
      { name: "parcel_id", type: "bigint", ref: "public.parcels.id", note: "on delete cascade" },
      { name: "kind", type: "text" },
      { name: "workflow_id", type: "text" },
    ] },
    { name: "ops.job_logs", columns: [
      { name: "id", type: "bigserial", key: "pk" },
      { name: "workflow_id", type: "text" },
    ] },
  ]}
  links={[
    { from: "ops.job_logs.workflow_id", to: "public.parcel_events.workflow_id", label: "same workflow, no FK" },
  ]}
  lenses={[
    { label: "collector", note: "Inserts parcels and their events, nothing else.", access: { "public.parcels": "write", "public.parcel_events": "write" } },
    { label: "worker-core", note: "Reads and writes public, writes ops.job_logs.", access: { "public.*": "read-write", "ops.job_logs": "write" } },
  ]}
/>
```

### Worked example: a domain model

The plan, five lines kept out of the page:

1. Question: where does a resource come from?
2. Claim: a resource exists only because a source declares it.
3. Form: Schema with entity cards, because the question is which things exist and how they relate.
4. Parts: the three terms from the glossary that answer it, with their attributes. Selection is left out.
5. Cases: none; the verbs carry it.

The figure:

```mdx
<Schema
  id="source-domain"
  title="A resource exists only because a source declares it"
  rule={{ title: "Read the verbs along the lines", text: "A crow's foot marks the many end." }}
  tables={[
    { name: "Source", columns: [{ name: "label" }, { name: "maintainers" }] },
    { name: "Resource declaration", columns: [{ name: "kind" }, { name: "declared path" }] },
    { name: "Resource", note: "identity: source, kind, name", columns: [{ name: "kind" }, { name: "name" }] },
  ]}
  links={[
    { from: "Source", to: "Resource declaration", label: "declares", cardinality: "one-to-many" },
    { from: "Resource declaration", to: "Resource", label: "covers", cardinality: "one-to-many" },
  ]}
/>
```

## `Figure`

Answers: Anything no component fits: a pipeline, a process tree, a one-off mechanism.

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". |
| `kind` | No | What it depicts: `architecture`, `system` (the default), `schema` or `tree`. It picks the ground. |
| `summary` | No | One or two sentences under the caption, in plain text: Markdown is not rendered there. |
| `rule` | No | `{ title, text }`: the one rule the layout encodes. |
| `startWith` | No | Box ids offered as entry points. |
| `replays` | No | `{ id?, label, steps: [{ at: boxId, note }] }`: an ordered case. |
| `lenses` | No | `{ id?, label, note, focus?: [ids], blocked?: [ids], broken?: [ids] }`: a failure, a role, a moment. |
| `legend` | No | Names for what the drawing uses: a link style (`solid`, `dashed`, `muted`), a tint (`tint-1` to `tint-6`) or a shape. A link with no label needs a legend entry for its style. |
| `children` | Yes | One `Drawing`. |
| `Drawing` | | `{ height }`. Always 728 wide. Holds the kit elements below. |
| `Box` | | `{ id, x, y, label, detail?, about?, tint?: 1-6, shape?, w? }`. Shapes: `plain`, `store`, `queue`, `external`, `actor`, `sheet`. Its width follows from its text unless `w` is given. |
| `Link` | | `{ from, to, label?, style? }` between two box ids. The kit routes it as a curve. |
| `Band` | | `{ x, y, w, h, label, tint? }`: a labelled region, such as a tier, a boundary or a swimlane. |
| `Badge` | | `{ at: boxId, n }`: a numbered mark on a box. |
| `Note` | | `{ x, y, text, to?: boxId }`: a short annotation, with a leader line to a box. |
| `Label` | | `{ x, y, text, size?: "large" | "small", anchor? }`: free text in one of the two drawing sizes. |
| raw SVG | | Any other SVG element, such as `<path>`, for the one thing no element covers. Paint it with the token classes below. |

What the reader draws:

- The same frame as every figure: caption, cases, focus, panel, legend, text equivalent and view state, from the ids. Write no event handler.
- Links show at rest up to 12 boxes; above that, only the links of the box in focus.
- Bands first, then raw SVG, then links, notes, boxes and labels.
- The ground follows `kind`: quad-ruled for a system.

Budget, checked by `tack check`:

- At most 24 boxes and 12 steps in a replay.
- At most 1,200 px tall.
- The check reports boxes that overlap, text that does not fit its box, an element outside the drawing, a link that crosses a box that is not one of its ends, and unknown ids. It counts raw shapes it cannot check.

### Worked example

The plan, five lines kept out of the page:

1. Question: what happens between running the update and the new release being active?
2. Claim: nothing outside staging/ changes until the gate passes.
3. Form: an authored Figure, because no component draws a pipeline across two places on disk.
4. Parts: the export, the gate, the pointer swap; the two directories as bands.
5. Cases: a replay of a good update, a lens for a failed gate.

The figure:

```mdx
<Figure
  id="update-pipeline"
  kind="system"
  title="Nothing outside staging/ changes until the gate passes"
  rule={{ title: "Left to right", text: "Each step runs only when the one before it passed." }}
  startWith={["gate"]}
  legend={{ dashed: "only when the checkout is clean" }}
  replays={[{ label: "A good update", steps: [
    { at: "export", note: "git archive into a clean tree." },
    { at: "gate", note: "The built release is run for real." },
    { at: "swap", note: "current moves to the new release." },
  ] }]}
  lenses={[{ label: "The gate fails", note: "Nothing outside staging/ changed.", focus: ["export"], broken: ["gate"], blocked: ["swap"] }]}
>
  <Drawing height={200}>
    <Band x={16} y={12} w={452} h={176} label="staging/<uuid>" />
    <Band x={484} y={12} w={228} h={176} label="~/.local/share/tack" />
    <Box id="export" x={32} y={60} label="git archive" detail="clean tree, no .git" />
    <Box id="gate" x={260} y={60} label="gate-release" detail="5 min cap" />
    <Box id="swap" x={500} y={60} label="swap current" tint={2} shape="sheet" />
    <Link from="export" to="gate" label="release/" />
    <Link from="gate" to="swap" label="passes" />
    <Note x={260} y={160} text="fails: the commit is held" to="gate" />
  </Drawing>
</Figure>
```

## `Walkthrough`

Answers: In what order do steps or decisions apply, when a reader follows them one at a time?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". |
| `steps` | Yes | `{ title, body, readable? }` in order. `body` is text or JSX; give `readable` the plain text when `body` is JSX. |

What the reader draws:

- One step at a time, with Previous, Next and the step count; the step shown is kept in the view state.
- Copy and search get every step, numbered, whichever is shown.
- A short list a reader scans at once stays a numbered Markdown list.

Budget, checked by `tack check`:

- Every step has a title.

### Worked example

The plan, five lines kept out of the page:

1. Question: what does a first sync take?
2. Claim: three commands, and only the last one writes.
3. Form: Walkthrough, because the reader does them in order, one at a time.
4. Parts: pick, preview, apply.
5. Cases: none; the order carries it.

The figure:

```mdx
<Walkthrough
  id="first-sync"
  title="A first sync takes three commands"
  steps={[
    { title: "Pick", body: "Run tack pick and choose the skills this project needs." },
    { title: "Preview", body: "Run tack sync to see what would change; nothing is written." },
    { title: "Apply", body: "Run tack sync --apply to write the links." },
  ]}
/>
```

## `Chart`

Answers: How much, how many, when comparing sizes is the point?

| Prop | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique on the page. A short lowercase slug. |
| `title` | Yes | The claim, as a sentence of at least 4 words. Never a topic such as "Release layout". |
| `data` | Yes | `{ label, value }` per bar, in order. `value` is a finite number; never invent one. |
| `unit` | No | Shown after every value, such as `s` or `MB`. |
| `scenarios` | No | `{ id, label, multiplier }`: alternatives that scale every value, such as a slower network. The first shows first. |

What the reader draws:

- One horizontal bar per value, in order, with its label and value; pointing at a bar selects it.
- A scenario switch, a multiplier and a linear or square-root scale, kept in the view state.
- A few values of different units, or values a reader must look up, stay a Markdown table.

Budget, checked by `tack check`:

- Every value has a label and a finite number.

### Worked example

The plan, five lines kept out of the page:

1. Question: what makes a sync slow?
2. Claim: large folders dominate the time a sync takes.
3. Form: Chart, because the point is how the sizes compare.
4. Parts: three folder sizes, measured.
5. Cases: a scenario for a network home folder.

The figure:

```mdx
<Chart
  id="sync-time"
  title="Large folders dominate the time a sync takes"
  unit="s"
  data={[
    { label: "10 skills", value: 0.4 },
    { label: "100 skills", value: 1.2 },
    { label: "1,000 skills", value: 9.8 },
  ]}
  scenarios={[
    { id: "laptop", label: "Laptop SSD", multiplier: 1 },
    { id: "network", label: "Network home folder", multiplier: 4 },
  ]}
/>
```

## Token classes

Classes a source may use in its own components, its MDX and the raw SVG of an authored figure.
The reader styles them in both appearances. Never write a colour value.

- Colours, for `bg`, `text`, `border`, `fill` and `stroke`: `paper`, `sheet`, `rule`, `rule-strong`, `ink`, `body`, `muted`, `faint`, `pen`, `pen-wash`, `red`, `red-wash`. For example `stroke-muted` or `fill-sheet`.
- Fonts: `font-mono`, `font-sans`.
- Grounds: `tack-ground-quad-ruled`, `tack-ground-ruled-lines`, `tack-ground-dot-grid`.
- Tints, inside a figure: `tack-tint-1`, `tack-tint-2`, `tack-tint-3`, `tack-tint-4`, `tack-tint-5`, `tack-tint-6`, `tack-tint-fill`, `tack-tint-edge`. Pick one with `tack-tint-N` and paint with `tack-tint-fill` and `tack-tint-edge`.
