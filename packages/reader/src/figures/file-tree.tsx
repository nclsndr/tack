/**
 * `FileTree`: what is on disk, what points where and what is temporary, from an annotated tree
 * written as text. One row per entry on ruled lines, symlink arrows in lanes right of the names,
 * notes and sizes in aligned columns. Lenses show moments: which temporary entries exist.
 */
import { useId, useMemo } from "react";
import type { ReactNode } from "react";
import {
  CaseControls,
  FigureFrame,
  type FigureView,
  type FrameCase,
  Legend,
  type LegendItem,
  useFigureView,
} from "./frame.tsx";
import { DetailPanel, PinChips, ReadingPanel, viewLine } from "./panel.tsx";
import { KitDefs } from "./kit.tsx";
import {
  type FileTreeProps,
  fileTreeReadable,
  readFileTree,
  type TreeEntry,
  type TreeLens,
  type TreeModel,
} from "./file-tree-model.ts";
import {
  fileTreeLayoutIssues,
  layoutFileTree,
  rowText,
  type TreeArrow,
  type TreeLayout,
  treeGeometry,
} from "./file-tree-layout.ts";

export type { FileTreeProps } from "./file-tree-model.ts";

type RowInk = "focus" | "near" | "far" | "dim" | undefined;

/** The entries a focus inks: itself, its chain, what points at it, and their folders, faintly. */
function focusInk(model: TreeModel, focus: string): ReadonlyMap<string, RowInk> {
  const chain = model.links.get(focus)?.chain ?? [];
  const pointing = [...model.links].flatMap(([from, link]) =>
    link.chain.includes(focus) ? [from] : [],
  );
  const near = new Set([...chain, ...pointing]);
  const byId = new Map(model.entries.map((entry) => [entry.id, entry]));
  const ancestors = (id: string): readonly string[] => {
    const parent = byId.get(id)?.parent;
    return parent === undefined ? [] : [parent, ...ancestors(parent)];
  };
  const far = new Set([focus, ...near].flatMap(ancestors));
  return new Map(
    model.entries.map((entry): [string, RowInk] => [
      entry.id,
      entry.id === focus
        ? "focus"
        : near.has(entry.id)
          ? "near"
          : far.has(entry.id)
            ? "far"
            : "dim",
    ]),
  );
}

/** A lane arrow with rounded corners: out of the link's row, along the lane, into the target's. */
function arrowPath(arrow: TreeArrow): string {
  const r = Math.min(6, Math.abs(arrow.y2 - arrow.y1) / 2);
  const down = arrow.y2 > arrow.y1 ? 1 : -1;
  return [
    `M ${arrow.x1} ${arrow.y1}`,
    `H ${arrow.x - r}`,
    `Q ${arrow.x} ${arrow.y1} ${arrow.x} ${arrow.y1 + r * down}`,
    `V ${arrow.y2 - r * down}`,
    `Q ${arrow.x} ${arrow.y2} ${arrow.x - r} ${arrow.y2}`,
    `H ${arrow.x2 + 4}`,
  ].join(" ");
}

type DrawingProps = {
  readonly model: TreeModel;
  readonly layout: TreeLayout;
  readonly view: FigureView;
  readonly lens: TreeLens | undefined;
  readonly arrow: string;
  readonly hatch: string;
};

function TreeDrawing({ model, layout, view, lens, arrow, hatch }: DrawingProps): ReactNode {
  const g = treeGeometry;
  const focus = view.preview ?? view.pin;
  const inks = focus === undefined ? undefined : focusInk(model, focus);
  const lensFocus = new Set(lens?.focus ?? []);
  const inkOf = (entry: TreeEntry): RowInk => {
    if (inks !== undefined) return inks.get(entry.id);
    if (lens !== undefined && lensFocus.size > 0) return lensFocus.has(entry.id) ? "near" : "dim";
    return undefined;
  };
  const tempOf = (entry: TreeEntry): "sometimes" | "present" | "absent" | undefined => {
    if (entry.temp === false) return undefined;
    if (lens === undefined) return "sometimes";
    return lens.present.includes(entry.id) ? "present" : "absent";
  };
  const lit = (id: string): boolean => {
    const ink = inks?.get(id);
    return ink === "focus" || ink === "near";
  };
  const largest = layout.sizeX;
  return (
    <svg
      className="tack-map tack-tree"
      viewBox={`0 0 ${layout.width} ${Math.max(layout.height, 1)}`}
      width={layout.width}
      role="group"
      aria-label={`${model.title}. ${model.entries.length} entries.`}
      onClick={() => view.release()}
    >
      <KitDefs arrow={arrow} hatch={hatch} />
      <g className="tack-tree-guides" aria-hidden="true">
        {layout.guides.map((guide) => (
          <g key={`${guide.x}:${guide.y1}`}>
            <line x1={guide.x} x2={guide.x} y1={guide.y1} y2={guide.y2} />
            {guide.ticks.map((y) => (
              <line key={y} x1={guide.x} x2={guide.x + 7} y1={y} y2={y} />
            ))}
          </g>
        ))}
      </g>
      {model.entries.map((entry) => {
        const row = layout.rows.get(entry.id);
        if (row === undefined) return null;
        const baseline = row.y + g.pitch / 2 + 4;
        const nameX = row.x + g.inset;
        const width = rowText(entry).length * g.nameChar;
        const temp = tempOf(entry);
        const operable = entry.ellipsis === false;
        return (
          <g
            key={entry.id}
            className="tack-tree-row"
            data-entry={entry.id}
            data-ink={inkOf(entry)}
            data-directory={entry.directory ? "" : undefined}
            data-key={entry.key ? "" : undefined}
            data-temp={temp}
            data-pinned={view.pin === entry.id ? "" : undefined}
            {...(operable
              ? {
                  tabIndex: 0,
                  role: "button",
                  "aria-pressed": view.pin === entry.id,
                  "aria-label": `${entry.id}${entry.note === undefined ? "" : `, ${entry.note}`}`,
                  onMouseEnter: () => view.setPreview(entry.id),
                  onMouseLeave: () => view.setPreview(undefined),
                  onFocus: () => view.setPreview(entry.id),
                  onBlur: () => view.setPreview(undefined),
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation();
                    view.togglePin(entry.id);
                  },
                  onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    view.togglePin(entry.id);
                  },
                }
              : { "aria-hidden": true })}
          >
            <title>{entry.id}</title>
            <rect className="tack-tree-hit" x={0} y={row.y} width={layout.width} height={row.h} />
            {entry.key || temp !== undefined ? (
              <rect
                className="tack-tree-mark"
                x={nameX - 4.5}
                y={row.y + 3.5}
                width={Math.round(width + 9)}
                height={g.pitch - 7}
                rx={2}
              />
            ) : null}
            <rect
              className="tack-map-ring"
              x={nameX - 7}
              y={row.y + 1}
              width={Math.round(width + 14)}
              height={g.pitch - 2}
              rx={4}
            />
            <text className="tack-tree-name" x={nameX} y={baseline}>
              {entry.name}
              {entry.target === undefined ? null : (
                <tspan className="tack-tree-target">{` -> ${entry.target}`}</tspan>
              )}
            </text>
            {row.note.map((line, index) => (
              <text
                key={index}
                className="tack-tree-note"
                x={layout.notesX}
                y={baseline + index * g.pitch}
              >
                {line}
              </text>
            ))}
            {temp === "absent" ? (
              <text className="tack-tree-stamp" x={layout.stampX} y={baseline} textAnchor="end">
                absent
              </text>
            ) : null}
            {entry.size === undefined || largest === undefined || temp === "absent" ? null : (
              <>
                <text className="tack-tree-size" x={largest} y={baseline} textAnchor="end">
                  {entry.size.text}
                </text>
                <rect
                  className="tack-tree-bar"
                  x={largest + 8}
                  y={row.y + g.pitch / 2 - 2}
                  width={row.bar ?? 0}
                  height={4}
                  rx={1}
                />
              </>
            )}
          </g>
        );
      })}
      <g className="tack-tree-arrows">
        {layout.arrows.map((item) => {
          // An arrow is part of the focus when it leaves an inked link: the chain runs through it.
          const active = inks === undefined ? undefined : lit(item.from);
          return (
            <path
              key={item.from}
              className="tack-map-link"
              data-kind={active === undefined ? "rest" : active ? "out" : "fade"}
              d={arrowPath(item)}
              markerEnd={`url(#${arrow})`}
            />
          );
        })}
      </g>
    </svg>
  );
}

function legendItems(model: TreeModel): readonly LegendItem[] {
  const mark = (attribute: string): ReactNode => (
    <svg className="tack-legend-mark" width="22" height="12" aria-hidden="true">
      <g
        className="tack-tree-row"
        {...{ [attribute]: attribute === "data-temp" ? "sometimes" : "" }}
      >
        <rect className="tack-tree-mark" x="1.5" y="1.5" width="19" height="9" rx="2" />
      </g>
    </svg>
  );
  return [
    ...(model.entries.some((entry) => entry.key)
      ? [{ key: "key", label: "key entry", mark: mark("data-key") }]
      : []),
    ...(model.entries.some((entry) => entry.temp)
      ? [{ key: "temp", label: "exists only sometimes", mark: mark("data-temp") }]
      : []),
    ...(model.links.size > 0
      ? [
          {
            key: "symlink",
            label: "symlink, to where it resolves",
            mark: (
              <svg className="tack-legend-mark" width="22" height="8" aria-hidden="true">
                <line x1="1" x2="21" y1="4" y2="4" className="tack-map-link" data-kind="rest" />
              </svg>
            ),
          },
        ]
      : []),
    ...(model.entries.some((entry) => entry.size !== undefined)
      ? [
          {
            key: "size",
            label: "size, to scale with the largest",
            mark: (
              <svg className="tack-legend-mark" width="22" height="8" aria-hidden="true">
                <rect className="tack-tree-bar" x="1" y="2" width="20" height="4" rx="1" />
              </svg>
            ),
          },
        ]
      : []),
  ];
}

/** The details of a pinned entry: its path, note and size, and what it points at or is pointed at by. */
function PinnedEntry({
  model,
  view,
}: {
  readonly model: TreeModel;
  readonly view: FigureView;
}): ReactNode {
  const entry = model.entries.find((item) => item.id === view.pin);
  if (entry === undefined) return null;
  const name = (id: string): string => id;
  const link = model.links.get(entry.id);
  const pointing = [...model.links].flatMap(([from, item]) =>
    item.arrow === entry.id ? [from] : [],
  );
  return (
    <>
      <h4 className="tack-figure-key">Pinned</h4>
      <p className="tack-figure-who">
        <strong>{entry.name}</strong>
        <code>{entry.id}</code>
      </p>
      {entry.note === undefined ? null : <p>{entry.note}</p>}
      {entry.size === undefined ? null : <p>{entry.size.text}</p>}
      {link === undefined ? null : (
        <PinChips
          title="Resolves through"
          entries={link.chain.map((id) => ({ id, label: name(id) }))}
          view={view}
        />
      )}
      {pointing.length === 0 ? null : (
        <PinChips
          title="Pointed at by"
          entries={pointing.map((id) => ({ id, label: name(id) }))}
          view={view}
        />
      )}
    </>
  );
}

/**
 * Draws a directory as an annotated tree. Written as a fenced ```tree block; the reader turns the
 * block into this component and passes its text as `source`.
 */
export function FileTree(props: FileTreeProps): ReactNode {
  const read = useMemo(() => readFileTree(props), [props]);
  const { model } = read;
  const layout = useMemo(() => layoutFileTree(model), [model]);
  const issues = [...read.issues, ...fileTreeLayoutIssues(layout)];
  const cases: readonly FrameCase[] = model.lenses.map((lens) => ({
    id: lens.id,
    label: lens.label,
    kind: "lens",
    steps: 0,
  }));
  const ids = useId().replaceAll(":", "");
  const view = useFigureView(model.id, cases, (id) =>
    model.entries.some((entry) => entry.id === id && entry.ellipsis === false),
  );
  const lens = model.lenses.find((item) => item.id === view.active?.id);
  const labelOf = (id: string): string => id;
  const panel = (
    <div className="tack-figure-panel">
      <ReadingPanel
        rule={model.rule}
        startWith={model.startWith.map((id) => ({ id, label: id }))}
        view={view}
      />
      <DetailPanel
        active={
          lens === undefined ? undefined : { kind: "lens", label: lens.label, note: lens.note }
        }
        view={view}
        labelOf={labelOf}
        pinned={view.pin === undefined ? undefined : <PinnedEntry model={model} view={view} />}
        hint="Point at an entry to see what points at it. Click it, or press Enter, to pin it."
      />
    </div>
  );
  return (
    <FigureFrame
      id={model.id}
      kind="tree"
      title={model.title}
      {...(model.summary === undefined ? {} : { summary: model.summary })}
      issues={issues}
      readable={[
        fileTreeReadable(model),
        viewLine(
          view.active === undefined ? undefined : { kind: "lens", label: view.active.label },
          view,
          labelOf,
        ),
      ]
        .filter((line) => line !== "")
        .join("\n")}
      state={view.state}
      className="tack-file-tree"
      controls={<CaseControls cases={cases} view={view} />}
      drawing={(mode) => (
        <TreeDrawing
          model={model}
          layout={layout}
          view={view}
          lens={lens}
          arrow={`${ids}-${mode}-arrow`}
          hatch={`${ids}-${mode}-hatch`}
        />
      )}
      panel={panel}
      legend={<Legend items={legendItems(model)} />}
      onEscape={() => view.release()}
    />
  );
}
