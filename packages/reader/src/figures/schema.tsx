/**
 * `Schema`: which tables or entities exist, how they relate at the level of a column, how they
 * group, and which role may read or write what, on one drawing. The layout engine packs the cards
 * once the page needs it; the kit draws the cards, the group regions and every relation, from the
 * row of one column to the row of the column it joins.
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
import { type Ink, kitBoxHandlers, type KitCurveKind, KitDefs, KitLink } from "./kit.tsx";
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { useEngineLayout } from "./engine-layout.ts";
import { figureLook } from "./look.ts";
import {
  type Access,
  accessOf,
  accessStamp,
  readSchema,
  type SchemaCase,
  schemaFocus,
  schemaLabel,
  type SchemaModel,
  schemaPlaceLabel,
  type SchemaProps,
  schemaReadable,
  type SchemaTable,
} from "./schema-model.ts";
import {
  layoutSchema,
  type SchemaCard,
  type SchemaLayout,
  schemaLayoutIssues,
  schemaRelationCurves,
} from "./schema-layout.ts";

export type { SchemaProps } from "./schema-model.ts";

type Inking = {
  readonly table: (name: string) => Ink;
  readonly relation: (from: string, to: string) => KitCurveKind;
  /** Columns a replay step names, as `table.column`. */
  readonly lit: ReadonlySet<string>;
  /** What the active role may do to each table; empty without an access lens. */
  readonly access: ReadonlyMap<string, Access>;
};

/** The table a replay step's id names: the table itself, or the table of a column. */
const tableOf = (model: SchemaModel, id: string): string =>
  model.tables.some((table) => table.name === id) ? id : id.slice(0, id.lastIndexOf("."));

/** How every card and relation is inked: by the focus, else the active case, else at rest. */
function inking(model: SchemaModel, view: FigureView, active: SchemaCase | undefined): Inking {
  const focusName = view.preview ?? (active === undefined ? view.pin : undefined);
  const none = { lit: new Set<string>(), access: new Map<string, Access>() };
  if (focusName !== undefined) {
    const focus = schemaFocus(model, focusName);
    return {
      ...none,
      table: (name) =>
        name === focusName ? "focus" : focus.near.has(name) === true ? "near" : "off",
      relation: (from, to) => (from === focusName ? "out" : to === focusName ? "in" : "fade"),
    };
  }
  if (active?.kind === "replay") {
    const steps = active.steps.slice(0, view.step);
    const now = new Set((steps.at(-1)?.at ?? []).map((id) => tableOf(model, id)));
    const seen = new Set(steps.flatMap((step) => step.at.map((id) => tableOf(model, id))));
    return {
      ...none,
      lit: new Set(steps.flatMap((step) => step.at)),
      table: (name) =>
        now.has(name) === true ? "focus" : seen.has(name) === true ? "visited" : "dim",
      relation: (from, to) => (seen.has(from) === true && seen.has(to) === true ? "trace" : "fade"),
    };
  }
  if (active?.kind === "lens") {
    const access = new Map(
      model.tables.flatMap((table) => {
        const level = accessOf(active, table);
        return level === undefined ? [] : [[table.name, level] as const];
      }),
    );
    const inked = (name: string): boolean =>
      active.access === undefined ? active.focus.includes(name) : access.get(name) !== "none";
    return {
      lit: new Set(),
      access,
      table: (name) => (access.get(name) === "none" ? "blocked" : inked(name) ? "near" : "off"),
      relation: (from, to) => (inked(from) && inked(to) ? "rest" : "fade"),
    };
  }
  return { ...none, table: () => undefined, relation: () => "rest" };
}

/** One table's card: header, rows with key marks, names, types and notes, and unique sets. */
function Card({
  card,
  table,
  entities,
  ink,
  inking: state,
  view,
  hatch,
}: {
  readonly card: SchemaCard;
  readonly table: SchemaTable;
  readonly entities: boolean;
  readonly ink: Ink;
  readonly inking: Inking;
  readonly view: FigureView;
  readonly hatch: string;
}): ReactNode {
  const radius = figureLook.boxRadius;
  const x = Math.round(card.x) + 0.5;
  const w = Math.round(card.x + card.w) - 0.5 - x;
  const h = card.h - 1;
  const access = state.access.get(table.name);
  const stamp = access === undefined || access === "none" ? undefined : accessStamp[access];
  return (
    <g
      className="tack-map-box tack-schema-card"
      data-box={table.name}
      data-tint={card.tint}
      data-ink={ink}
      data-shape="plain"
      data-pinned={view.pin === table.name ? "" : undefined}
      transform={`translate(${x} ${card.y + 0.5})`}
      {...kitBoxHandlers(view, table.name, `${entities ? "entity" : "table"} ${table.name}`)}
    >
      <title>{table.name}</title>
      <rect className="tack-map-ring" x={-3} y={-3} width={w + 6} height={h + 6} rx={radius + 3} />
      <rect className="tack-map-shape" width={w} height={h} rx={radius} />
      <text className="tack-map-label tack-schema-name" x={10} y={18}>
        {card.text}
      </text>
      {table.note === undefined ? null : (
        <text className="tack-schema-note" x={10} y={32}>
          {table.note}
        </text>
      )}
      {stamp === undefined ? null : (
        <g className="tack-schema-stamp-mark" transform={`translate(${w - 8} 6)`}>
          <rect x={-stamp.length * 7 - 8} width={stamp.length * 7 + 8} height={16} rx={2} />
          <text className="tack-schema-stamp" x={-4} y={12} textAnchor="end">
            {stamp}
          </text>
        </g>
      )}
      <line className="tack-schema-rule" x1={0} x2={w} y1={card.head} y2={card.head} />
      {table.columns.map((column, index) => {
        const row = card.rows[index];
        if (row === undefined) return null;
        const key =
          column.key === "pk" ? "PK" : column.key === "unique" ? "UQ" : column.foreign ? "FK" : "";
        return (
          <g
            key={column.name}
            className="tack-schema-row"
            data-lit={state.lit.has(`${table.name}.${column.name}`) ? "" : undefined}
          >
            <rect className="tack-schema-row-wash" x={1} y={row.y} width={w - 2} height={row.h} />
            {key === "" ? null : (
              <text
                className="tack-schema-key"
                data-key={column.key ?? "foreign"}
                x={8}
                y={row.mid + 4}
              >
                {key}
              </text>
            )}
            <text className="tack-schema-column" x={card.gutter} y={row.mid + 4}>
              {column.name}
              {column.nullable ? "?" : ""}
            </text>
            {column.type === undefined ? null : (
              <text className="tack-schema-type" x={w - 8} y={row.mid + 4} textAnchor="end">
                {column.type}
              </text>
            )}
            {column.note === undefined ? null : (
              <text className="tack-schema-note" x={card.gutter} y={row.mid + 18}>
                {column.note}
              </text>
            )}
          </g>
        );
      })}
      {table.unique.map((set, index) => (
        <text
          key={set.join(",")}
          className="tack-schema-note tack-schema-unique"
          x={10}
          y={(card.rows.at(-1)?.y ?? card.head) + (card.rows.at(-1)?.h ?? 0) + 12 + index * 16}
        >
          unique ({set.join(", ")})
        </text>
      ))}
      {ink === "blocked" ? (
        <rect
          width={w}
          height={h}
          rx={radius}
          fill={`url(#${hatch})`}
          className="tack-map-blocked"
        />
      ) : null}
    </g>
  );
}

type DrawingProps = {
  readonly model: SchemaModel;
  readonly layout: SchemaLayout;
  readonly view: FigureView;
  readonly active: SchemaCase | undefined;
  readonly hatch: string;
};

/** The schema as one SVG: group regions, relations with their marks, cards, labels. */
function SchemaDrawing({ model, layout, view, active, hatch }: DrawingProps): ReactNode {
  const ink = inking(model, view, active);
  const curves = schemaRelationCurves(model, layout);
  const relations = new Map(model.relations.map((relation) => [relation.id, relation]));
  return (
    <svg
      className="tack-map tack-schema-drawing"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      data-overflow={layout.fits ? undefined : ""}
      data-entities={model.entities ? "" : undefined}
      role="group"
      aria-label={`${model.title}. ${model.tables.length} ${model.entities ? "entities" : "tables"}, ${model.relations.length} relations.`}
      onClick={() => view.release()}
    >
      <KitDefs arrow={`${hatch}-arrow`} hatch={hatch} />
      {[...layout.groups].map(([id, region]) => (
        <g key={id} className="tack-kit-band tack-schema-group" data-tint={region.tint}>
          <rect
            x={region.x + 0.5}
            y={region.y + 0.5}
            width={region.w - 1}
            height={region.h - 1}
            rx={3}
          />
          <text x={region.x + 10} y={region.y + 20}>
            {region.label}
          </text>
          {region.note === undefined ? null : (
            <text
              className="tack-schema-group-note"
              x={region.x + 18 + region.label.length * 7.6}
              y={region.y + 20}
            >
              {region.note}
            </text>
          )}
        </g>
      ))}
      <g className="tack-map-links">
        {curves.map((curve) => {
          const relation = relations.get(curve.id);
          const kind = ink.relation(curve.tables[0], curve.tables[1]);
          const style = relation?.kind === "link" && model.entities === false ? "dashed" : "solid";
          return (
            <g key={curve.id}>
              <KitLink link={curve.id} curve={curve.curve} kind={kind} style={style} />
              {curve.marks === "" ? null : (
                <path
                  className="tack-map-link tack-schema-marks"
                  data-kind={kind}
                  d={curve.marks}
                />
              )}
            </g>
          );
        })}
      </g>
      {model.tables.map((table) => {
        const card = layout.cards.get(table.name);
        return card === undefined ? null : (
          <Card
            key={table.name}
            card={card}
            table={table}
            entities={model.entities}
            ink={ink.table(table.name)}
            inking={ink}
            view={view}
            hatch={hatch}
          />
        );
      })}
      <g className="tack-map-marks" aria-hidden="true">
        {curves.map((curve) => {
          const label = relations.get(curve.id)?.label;
          const kind = ink.relation(curve.tables[0], curve.tables[1]);
          return curve.label === undefined || label === undefined || kind === "fade" ? null : (
            <text
              key={curve.id}
              className="tack-map-link-label"
              data-kind={kind}
              data-link={curve.id}
              textAnchor="middle"
              x={curve.label.x}
              y={curve.label.y + 3.5}
            >
              {label}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

/** The details of the pinned table: its group, its note, and the sentence of what it joins. */
function PinnedTable({
  model,
  table,
  view,
}: {
  readonly model: SchemaModel;
  readonly table: SchemaTable;
  readonly view: FigureView;
}): ReactNode {
  const group = model.groups.find((candidate) => candidate.id === table.group);
  const focus = schemaFocus(model, table.name);
  const name = (other: string): string => schemaLabel(model, other);
  return (
    <>
      <h4 className="tack-figure-key">
        Pinned, {model.entities ? "an entity" : "a table"}
        {group === undefined ? "" : ` in ${group.label}`}
      </h4>
      <p className="tack-figure-who">
        <strong>{table.short}</strong>
        {table.note === undefined ? null : <code>{table.note}</code>}
      </p>
      <p>{focus.sentence}</p>
      <PinChips
        title="References"
        entries={focus.out.map((relation) => ({
          id: relation.to.table,
          label: name(relation.to.table),
        }))}
        view={view}
      />
      <PinChips
        title="Referenced by"
        entries={focus.incoming.map((relation) => ({
          id: relation.from.table,
          label: name(relation.from.table),
        }))}
        view={view}
      />
    </>
  );
}

/** The legend items the drawing uses: groups, key marks, relation styles, access stamps. */
function legendItems(model: SchemaModel): readonly LegendItem[] {
  const line = (kind: KitCurveKind, style: string): ReactNode => (
    <svg className="tack-legend-mark" width="22" height="8" aria-hidden="true">
      <line
        x1="1"
        x2="21"
        y1="4"
        y2="4"
        className="tack-map-link"
        data-kind={kind}
        data-style={style}
      />
    </svg>
  );
  const tag = (text: string): ReactNode => (
    <span className="tack-legend-tag" aria-hidden="true">
      {text}
    </span>
  );
  const columns = model.tables.flatMap((table) => table.columns);
  const keys = model.relations.some((relation) => relation.kind === "key");
  const links = model.relations.some((relation) => relation.kind === "link");
  const access = model.cases.some((item) => item.kind === "lens" && item.access !== undefined);
  return [
    ...model.groups.map((group) => ({
      key: `group:${group.id}`,
      label: group.label,
      mark: <span className="tack-legend-swatch" data-tint={group.tint} aria-hidden="true" />,
    })),
    ...(columns.some((column) => column.key === "pk")
      ? [{ key: "pk", label: "primary key", mark: tag("PK") }]
      : []),
    ...(columns.some((column) => column.foreign)
      ? [{ key: "fk", label: "foreign key", mark: tag("FK") }]
      : []),
    ...(columns.some((column) => column.key === "unique")
      ? [{ key: "uq", label: "unique", mark: tag("UQ") }]
      : []),
    ...(columns.some((column) => column.nullable)
      ? [{ key: "nullable", label: "nullable", mark: tag("?") }]
      : []),
    ...(keys
      ? [{ key: "key", label: "foreign key, many to one", mark: line("rest", "solid") }]
      : []),
    ...(links && model.entities === false
      ? [{ key: "link", label: "not a key", mark: line("rest", "dashed") }]
      : []),
    ...(access
      ? [
          { key: "rw", label: "read and write", mark: tag("RW") },
          { key: "r", label: "read", mark: tag("R") },
          { key: "w", label: "write", mark: tag("W") },
          {
            key: "none",
            label: "no access",
            mark: <span className="tack-legend-swatch" data-blocked="" aria-hidden="true" />,
          },
        ]
      : []),
    ...(model.cases.some((item) => item.kind === "replay")
      ? [{ key: "trace", label: "replay path", mark: line("trace", "solid") }]
      : []),
  ];
}

/** Draws tables or entities and how they relate, from meaning only: no positions, no colours. */
export function Schema(props: SchemaProps): ReactNode {
  const read = useMemo(() => readSchema(props), [props]);
  const { model } = read;
  const laid = useEngineLayout("schema", model, layoutSchema);
  const layouts = laid !== undefined && "layouts" in laid ? laid.layouts : undefined;
  const layoutIssues: readonly FigureIssue[] =
    laid === undefined
      ? []
      : "layouts" in laid
        ? schemaLayoutIssues(laid.layouts.column)
        : [layoutIssue(`the layout engine failed: ${laid.failure}`)];
  const cases: readonly FrameCase[] = model.cases.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    steps: item.kind === "replay" ? item.steps.length : 0,
  }));
  const ids = useId().replaceAll(":", "");
  const view = useFigureView(model.id, cases, (name) =>
    model.tables.some((table) => table.name === name),
  );
  const active = model.cases.find((item) => item.id === view.active?.id);
  const name = (id: string): string => schemaLabel(model, id);
  const pinned = model.tables.find((table) => table.name === view.pin);
  const panelCase =
    active?.kind === "replay"
      ? {
          kind: "replay" as const,
          label: active.label,
          steps: active.steps.map((step) => ({
            at: step.at.map((id) => schemaPlaceLabel(model, id)).join(", "),
            note: step.note,
          })),
        }
      : active;
  const panel = (
    <div className="tack-figure-panel">
      <ReadingPanel
        rule={model.rule}
        startWith={model.startWith.map((id) => ({ id, label: name(id) }))}
        view={view}
      />
      <DetailPanel
        active={panelCase}
        view={view}
        labelOf={(text) => text}
        pinned={
          pinned === undefined ? undefined : (
            <PinnedTable model={model} table={pinned} view={view} />
          )
        }
        hint={
          model.entities
            ? "Point at an entity to see what it relates to. Click it, or press Enter, to pin it."
            : "Point at a table to see what it references. Click it, or press Enter, to pin it."
        }
      />
    </div>
  );
  return (
    <FigureFrame
      id={model.id}
      kind="schema"
      title={model.title}
      {...(model.summary === undefined ? {} : { summary: model.summary })}
      issues={[...read.issues, ...layoutIssues]}
      readable={[
        schemaReadable(model),
        viewLine(
          active === undefined
            ? undefined
            : {
                kind: active.kind,
                label: active.label,
                ...(active.kind === "replay" ? { steps: active.steps.length } : {}),
              },
          view,
          name,
        ),
      ]
        .filter((line) => line !== "")
        .join("\n")}
      state={view.state}
      className="tack-schema"
      controls={<CaseControls cases={cases} view={view} />}
      drawing={(mode) =>
        layouts === undefined ? (
          <p className="tack-figure-pending" role="status">
            {laid === undefined ? "Laying out the figure…" : "The figure could not be laid out."}
          </p>
        ) : (
          <SchemaDrawing
            model={model}
            layout={layouts[mode]}
            view={view}
            active={active}
            hatch={`${ids}-${mode}-hatch`}
          />
        )
      }
      panel={panel}
      legend={<Legend items={legendItems(model)} />}
      onEscape={() => view.release()}
    />
  );
}
