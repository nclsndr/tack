---
name: write-reader-figures
description: Write figures in Tack docs - architecture maps, running systems, schemas and domain models, file trees, walkthroughs, charts and authored figures that the docs reader renders with one frame. Use when a document needs a picture of how code is organised, which parts run and what they send each other, which tables or entities exist and who may touch them, what is on disk, an ordered procedure, quantities or a one-off mechanism, before writing any figure or a `tree` block, and instead of ASCII art. Also for icons, callouts, tabs and defined terms in MDX docs. Run `tack check` on the page when done.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: default
---

# Write reader figures

The Tack docs reader renders figure components in `.mdx` documents, and `tree` blocks in `.md`
and `.mdx`. You write meaning: tiers, boxes, links, entries, steps, values. The reader owns every
position, size, colour and interaction, so no component prop takes a coordinate. Every figure gets
the same frame: a numbered caption with your claim, an optional summary, the drawing, a panel, a
legend and, when something is wrong, its issues. For the rare figure no component fits, you place
kit elements yourself (section 8) and still get the same frame.

The components are available in every document without an import. The props of each one are in
[references/figure-components.md](references/figure-components.md), with a worked example.

## 1. When to draw

A figure earns its place when it shows a mechanism the viewer would otherwise assemble from
prose: what may use what, what a command passes through, what changes when a part fails. If a
sentence or a table says it faster, write the sentence or the table.

## 2. Plan first

Write these five lines for yourself before the figure. Do not put them in the page.

1. Question: what is the viewer asking? ("Where does this code belong?")
2. Claim: the one sentence the figure proves. It becomes the `title`.
3. Form: pick it from the table below, by the question.
4. Parts: the elements the claim turns on. Name what you leave out.
5. Cases: the situations worth replaying on the same drawing: a command, a request, a failure.

## 3. Pick the form by the question

| The viewer asks                                                                        | Use                                                                                                       | Not                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| How is the code organised, what may use what, which parts does a command pass through? | `ArchitectureMap`: tiers of real modules, the rule in words, a replay of a real command                   | A box per folder with every import drawn at once |
| Which parts run and what do they send each other? What happens when one fails?         | `System`: real containers or processes, a verb on every link, a replay of one request, a lens per failure | Same-shaped boxes with unlabelled arrows         |
| Which tables or entities exist, how do they join, and which role may touch what?       | `Schema`: real tables and columns, a `ref` per foreign key, a lens per role with `access`                 | Entity names in boxes, a grants matrix under it  |
| In what order do decisions or steps apply?                                             | `Walkthrough`: numbered steps                                                                             | A flowchart of a straight line                   |
| What is on disk, what points where, what is temporary?                                 | A `tree` block (`FileTree`): real paths, symlinks as `->`, notes, sizes, a lens per moment                | An ASCII tree in a `text` block                  |
| How much, how many?                                                                    | `Chart`, or numbers in a Markdown table                                                                   | A diagram                                        |
| Which values compare along several attributes?                                         | A Markdown table                                                                                          | A figure that restates the table                 |

For anything else, such as a pipeline across two places on disk or a process tree, write an
authored figure (section 8), or a Markdown table or a list when that says it faster. Do not draw ASCII art: an ASCII tree
becomes a figure by changing its fence to `tree` and marking its comments with `#`. The fence line
carries the id and the claim: ` ```tree id="release-on-disk" title="Each release is one immutable directory" `.

## 4. Rules

- State how to read it. An `ArchitectureMap` needs its `rule` ("Imports point down"), two to four
  `startWith` entry points, and at least one replay of a real command or request.
- One claim per figure. The `title` is the claim as a sentence ("A page never reads the database"),
  never a topic ("Data flow"). The check rejects titles under four words.
- Draw the mechanism, not the names. If the drawing would mean the same with the labels shuffled,
  it is a list.
- Show real artefacts: real module paths, command names, column names. No "Service A".
- Give a link a specific verb when it is not plain use (`implements`, `wires`, `INSERT`). "Uses",
  "calls" and "handles" say nothing. In a `System` every link needs its label.
- Links follow the data. In a `System`, write each link the way the data or the request moves, so
  the drawing reads as a path. A consumer reads from a queue: the link goes from the queue to the
  consumer (`redis -> worker-core: XREADGROUP`), not from the consumer to the queue. An answer to
  the link before it, such as an acknowledgement, is `kind: "reply"`; a task queue is
  `kind: "async"`. The check cannot know the direction of data: you must.
- Respect the budget of the form (in the reference). A map holds up to 60 boxes because links stay
  hidden until a box is in focus: show the real modules, not five summary boxes.
- Replay, do not repeat. A command, a failure or a role is a replay or a lens on the same drawing,
  not a second figure. A failure is a lens: `focus` names what keeps working, `broken` what is
  down. A table of failures becomes one lens per row.
- A role is a lens. In a `Schema`, give each role a lens with `access` (`"public.*": "read"`,
  `"ops.job_logs": "write"`); a table it does not list is `none`. `write` covers insert, update and
  delete: when a role may only insert, say so in the lens note. Do not keep a grants table beside
  the figure. A replay is worth adding only for a real query; the roles are the cases. Write keys as `ref` on the column, so the relation ends on that column; use
  `links` only for a relation with no foreign key, and say so in its label. A domain model is a
  `Schema` whose columns have no `type`: entities, their attributes, verbs with a `cardinality`.
- Do not restate a neighbouring table as a figure. Keep the one that answers the question.
- Introduce each figure with one sentence that says what to look for.
- The ground behind a drawing depends on what it shows (quad-ruled paper for an architecture). It
  is a default the reader picks, not something to set or fight.

## 5. Be bold where it pays

The timid defaults are three boxes in a row, a figure that restates its table, one figure of the
whole system, generic verbs on links, and an ASCII drawing. Each is a sign the claim is missing.
Spend the boldness on the one thing the viewer must see: the barrier between two sibling tiers,
the port where two layers meet, the step where a command crosses into a new tier. Make sure the
resting state, before any click, already answers the main question.

## 6. Derive, do not type

Relations that exist in code or data come from a script, not from memory. Generate a data module
next to the page and import it:

```mdx
import { links } from "./cli-imports.ts";

<ArchitectureMap id="cli-architecture" title="..." rule={{ title: "...", text: "..." }} tiers={[...]} links={links} />
```

The data module exports literal data (`export const links = [...]`). The figure check reads it
without running anything, so keep it literal: no function calls, no computed values. A figure whose
props are computed when the page runs is reported as not checked. Write the generator script beside
the page and rerun it when the code changes.

## 7. The component reference

[references/figure-components.md](references/figure-components.md) lists the props of every
component and kit element, what the reader draws, the budget the check enforces, and one worked
example each: the five plan lines, then the input. It also lists the token classes you may use.
It is generated from the reader's own contracts, so it is always the current truth.

## 8. Authored figures

Use an authored figure only when no component fits the question: a pipeline across two places on
disk, a process tree, a tank that fills. You compose a `<Figure>` with one `<Drawing height>` of
kit elements at explicit positions: `Box`, `Link`, `Band`, `Badge`, `Note`, `Label`. The frame
still gives it the caption, cases, focus, panel, legend, text equivalent and view state.

1. Use the kit's `Drawing`. It is always 728 wide. Keep a 16 px margin and place on a 4 px grid.
2. Place kit elements. Use raw SVG (`<path>`, `<rect>`) only for the bespoke part no element
   covers.
3. No colour values and no inline styles. Tints (`tint={1}` to `6`) and ink come from the kit;
   raw SVG takes the token classes of the reference.
4. Do not size a box by eye. Let it size itself from its text; give `w` only to align a column.
5. Two text sizes. Every link has a `label`, or its style has a `legend` entry. A link never
   crosses a box that is not one of its ends: move the boxes.
6. The resting picture answers the question. Focus, replays and lenses come from the frame, by
   ids. Do not write event handlers.
7. Give an `id` to every box that takes part in focus or in a case. The text equivalent is built
   from them.
8. Run the figure check. It reports overlaps, text that does not fit, elements outside the
   drawing and crossings, and counts the raw shapes it cannot check.

## 9. Check the page

Run the figure check on the document, or on its folder:

```sh
tack check docs/architecture.mdx
```

Write the page, run `tack check`, and repeat until clean. The combined report prints file:line
findings using the same figure, icon and author-component rules as the reader. Unknown icons produce `icon-unknown`; misused components produce `component-issue`. Errors exit 1; warnings exit 0. A
`figure-not-checked` warning means a prop is computed at runtime: make it literal or import it
from a static data module. No registered state or browser is needed for checking.

Then open the page in the reader (`tack docs serve`), point at a box, pin one, and run each replay
once to see that the steps read in order.

## 10. Icons

An `.mdx` page can mark a kind of thing with a Lucide icon, inline with the word it marks:
`<Icon name="database" /> Postgres`. Add `label="..."` only when the icon carries meaning the text
does not. Only the curated docs set works, so never write a name from memory: find one with
`tack docs icons <word>`. Names say what an icon draws, so search for the object you picture
(`flask` for research, `megaphone` for an announcement) or run it without a word to see them all;
it also maps an old Lucide name such as `home` to `house`. Write the name
as a plain string, also in a component, so the reader can bundle it. `tack check` names every
unknown icon by line with the closest names; fix them before finishing.

## 11. Callouts, tabs and terms

Three more components work in every `.mdx` page, without an import:

```mdx
<Callout kind="warning" title="Breaking">
  `tack check` replaces `docs check`; there are no aliases.
</Callout>

<Tabs>
  <Tab label="npm">`npm install --global @tackup/cli`</Tab>
  <Tab label="Bun">`bun add --global @tackup/cli`</Tab>
</Tabs>

A <Term title="A folder of resources Tack reads through its tack.yaml">source</Term> declares what it offers.
```

- `Callout` sets one note apart: `kind` is `note` (the default), `tip`, `warning` or `decision`,
  each with its icon; `title` is optional; `icon` swaps in a docs icon. One per point that must not
  be missed. Do not wrap ordinary paragraphs in it.
- `Tabs` holds alternatives a reader picks one of, such as per-platform steps. At least two `Tab`s,
  each with its own `label`. Do not hide sequential steps in tabs.
- `Term` defines a word on hover and focus; screen readers and copy get the definition after it.
  Define a term once, where it is first used.
- `<details><summary>…</summary>…</details>` folds long evidence; it needs no component.

`tack check` reports an unknown `kind`, a `Tab` without a label or outside `Tabs`, a label used
twice, `Tabs` with fewer than two tabs and a `Term` without `title`, by line, and so does the
reader's issue list.
