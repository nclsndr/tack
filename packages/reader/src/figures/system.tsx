/**
 * `System`: which parts run, what they send each other, where the boundaries are and what happens
 * when a part fails, on one drawing that is replayed instead of repeated. The layout engine places
 * the boxes once the page needs it; the kit draws the boxes, the group regions and every link.
 * Style means kind, ink means attention: focus and cases change the ink of a link, never its style.
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
import {
  type Ink,
  KitBadge,
  KitBox,
  type KitCurveKind,
  KitDefs,
  KitLink,
  type KitShape,
  KitShapeMark,
} from "./kit.tsx";
import { type FigureIssue, layoutIssue } from "./issues.ts";
import { useEngineLayout } from "./engine-layout.ts";
import {
  readSystem,
  type SystemCase,
  type SystemLinkKind,
  type SystemModel,
  type SystemNode,
  type SystemNodeKind,
  systemFocus,
  systemLabel,
  systemNodeKinds,
  systemLinkKinds,
  type SystemProps,
  systemReadable,
} from "./system-model.ts";
import {
  layoutSystem,
  type SystemCurve,
  type SystemLayout,
  systemLayoutIssues,
  systemLinkCurves,
} from "./system-layout.ts";

export type { SystemProps } from "./system-model.ts";

/** The kit shape each node kind is drawn with. */
const shapeOf: Readonly<Record<SystemNodeKind, KitShape>> = {
  service: "plain",
  store: "store",
  queue: "queue",
  external: "external",
  actor: "actor",
  artifact: "sheet",
};
/** The line style each link kind sets, in every state of the figure. */
const styleOf: Readonly<Record<SystemLinkKind, "solid" | "dashed" | "muted">> = {
  call: "solid",
  async: "dashed",
  reply: "muted",
};

type Inking = {
  readonly node: (id: string) => Ink;
  readonly link: (id: string) => { readonly kind: KitCurveKind; readonly last: boolean };
  /** Badges of the replay so far: the step numbers on each node or link. */
  readonly badges: ReadonlyMap<string, readonly number[]>;
};

/** How every node and link is inked: by the focus, else the active case, else at rest. */
function inking(model: SystemModel, view: FigureView, active: SystemCase | undefined): Inking {
  const focusId = view.preview ?? (active === undefined ? view.pin : undefined);
  const rest = { kind: "rest" as const, last: false };
  if (focusId !== undefined) {
    const focus = systemFocus(model, focusId);
    return {
      node: (id) => (id === focusId ? "focus" : focus.near.has(id) === true ? "near" : "off"),
      link: (id) => ({
        kind: focus.out.some((link) => link.id === id)
          ? "out"
          : focus.incoming.some((link) => link.id === id)
            ? "in"
            : "fade",
        last: false,
      }),
      badges: new Map(),
    };
  }
  if (active?.kind === "replay") {
    const steps = active.steps.slice(0, view.step);
    const current = steps.at(-1);
    const seen = new Set(steps.flatMap((step) => step.at));
    const broken = new Set(current?.broken ?? []);
    const now = new Set(current?.at ?? []);
    return {
      node: (id) =>
        broken.has(id) === true
          ? "broken"
          : now.has(id) === true
            ? "focus"
            : seen.has(id) === true
              ? "visited"
              : "dim",
      link: (id) =>
        broken.has(id) === true
          ? { kind: "broken", last: false }
          : seen.has(id) === true
            ? { kind: "trace", last: now.has(id) === true }
            : { kind: "fade", last: false },
      badges: steps.reduce<ReadonlyMap<string, readonly number[]>>((map, step, index) => {
        const first = step.at[0];
        return first === undefined
          ? map
          : new Map([...map, [first, [...(map.get(first) ?? []), index + 1]]]);
      }, new Map()),
    };
  }
  if (active?.kind === "lens")
    return {
      node: (id) =>
        active.broken.includes(id) === true
          ? "broken"
          : active.focus.includes(id) === true
            ? "near"
            : "off",
      link: (id) => {
        if (active.broken.includes(id) === true) return { kind: "broken", last: false };
        if (active.focus.includes(id) === true) return rest;
        return { kind: "fade", last: false };
      },
      badges: new Map(),
    };
  return { node: () => undefined, link: () => rest, badges: new Map() };
}

/** A link label on its link, one or two lines, with a halo in the ground colour. */
function LinkLabel({
  curve,
  kind,
}: {
  readonly curve: SystemCurve;
  readonly kind: KitCurveKind;
}): ReactNode {
  const { label } = curve;
  const { lines } = label;
  const first = label.y + 3.5 - ((lines.length - 1) * 13) / 2;
  return (
    <text
      className="tack-map-link-label"
      data-kind={kind}
      data-link={curve.id}
      textAnchor={label.anchor}
      x={label.x}
      y={first}
    >
      {lines.map((line, index) => (
        <tspan key={index} x={label.x} dy={index === 0 ? 0 : 13}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

type DrawingProps = {
  readonly model: SystemModel;
  readonly layout: SystemLayout;
  readonly view: FigureView;
  readonly active: SystemCase | undefined;
  readonly ids: { readonly arrow: string; readonly hatch: string; readonly stop: string };
};

/** The system as one SVG: group regions, links, boxes, labels and replay badges. */
function SystemDrawing({ model, layout, view, active, ids }: DrawingProps): ReactNode {
  const ink = inking(model, view, active);
  const curves = systemLinkCurves(model, layout);
  // Where a replay's step numbers sit: on a node, or beside a link's label.
  const anchors = new Map([
    ...[...layout.boxes.values()].map(
      (box) => [box.id, { x: Math.round(box.x) + 14, y: box.y }] as const,
    ),
    ...curves.map(({ id, label }) => [id, { x: label.x - label.w / 2 - 12, y: label.y }] as const),
  ]);
  return (
    <svg
      className="tack-map tack-system-drawing"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      data-overflow={layout.fits ? undefined : ""}
      role="group"
      aria-label={`${model.title}. ${model.nodes.length} parts, ${model.links.length} links.`}
      onClick={() => view.release()}
    >
      <KitDefs arrow={ids.arrow} hatch={ids.hatch} stop={ids.stop} />
      {[...layout.groups].map(([id, region]) => (
        <g key={id} className="tack-kit-band tack-system-group" data-tint={region.tint}>
          <rect
            x={region.x + 0.5}
            y={region.y + 0.5}
            width={region.w - 1}
            height={region.h - 1}
            rx={3}
          />
          <text x={region.x + 10} y={region.y + 18}>
            {region.label}
          </text>
        </g>
      ))}
      <g className="tack-map-links">
        {curves.map((curve) => {
          const state = ink.link(curve.id);
          return (
            <KitLink
              key={curve.id}
              link={curve.id}
              curve={curve.curve}
              kind={state.kind}
              arrow={ids.arrow}
              stop={ids.stop}
              style={styleOf[curve.kind]}
              last={state.last}
            />
          );
        })}
      </g>
      {[...layout.boxes.values()].map((box) => (
        <KitBox
          key={box.id}
          id={box.id}
          x={box.x}
          y={box.y}
          w={box.w}
          h={box.h}
          text={box.text}
          {...(box.detailText === undefined ? {} : { detailText: box.detailText })}
          lines={box.lineTexts}
          top={box.top}
          label={box.label}
          {...(box.detail === undefined ? {} : { detail: box.detail })}
          {...(box.tint === undefined ? {} : { tint: box.tint })}
          shape={shapeOf[box.kind]}
          ink={ink.node(box.id)}
          view={view}
          hatch={ids.hatch}
        />
      ))}
      <g className="tack-map-marks" aria-hidden="true">
        {curves.map((curve) => {
          const state = ink.link(curve.id);
          return state.kind === "fade" ? null : (
            <LinkLabel key={curve.id} curve={curve} kind={state.kind} />
          );
        })}
        {[...anchors].flatMap(([id, at]) =>
          (ink.badges.get(id) ?? []).map((n, index) => (
            <KitBadge key={`${id}:${n}`} x={at.x + index * 20} y={at.y} n={n} />
          )),
        )}
      </g>
    </svg>
  );
}

/** The details of the pinned node: its kind and group, its text, what it sends and receives. */
function PinnedNode({
  model,
  node,
  view,
}: {
  readonly model: SystemModel;
  readonly node: SystemNode;
  readonly view: FigureView;
}): ReactNode {
  const group = model.groups.find((candidate) => candidate.id === node.group);
  const focus = systemFocus(model, node.id);
  const name = (id: string): string => systemLabel(model, id);
  return (
    <>
      <h4 className="tack-figure-key">
        Pinned, a {node.kind}
        {group === undefined ? "" : ` in ${group.label}`}
      </h4>
      <p className="tack-figure-who">
        <strong>{node.label}</strong>
        {node.detail === undefined ? null : <code>{node.detail}</code>}
        {node.lines.map((line) => (
          <code key={line}>{line}</code>
        ))}
      </p>
      {node.about === undefined ? null : <p>{node.about}</p>}
      <PinChips
        title="Sends to"
        entries={focus.out.map((link) => ({ id: link.to, label: name(link.to), note: link.label }))}
        view={view}
      />
      <PinChips
        title="Receives from"
        entries={focus.incoming.map((link) => ({
          id: link.from,
          label: name(link.from),
          note: link.label,
        }))}
        view={view}
      />
    </>
  );
}

/** The legend items the drawing uses: groups, shapes, link kinds, the replay path, broken parts. */
function legendItems(model: SystemModel): readonly LegendItem[] {
  const line = (kind: KitCurveKind, style?: string): ReactNode => (
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
  const kinds = new Set(model.nodes.map((node) => node.kind));
  const linkKinds = new Set(model.links.map((link) => link.kind));
  const broken = model.cases.some((item) =>
    item.kind === "lens"
      ? item.broken.length > 0
      : item.steps.some((step) => step.broken.length > 0),
  );
  return [
    ...model.groups.map((group) => ({
      key: `group:${group.id}`,
      label: group.label,
      mark: <span className="tack-legend-swatch" data-tint={group.tint} aria-hidden="true" />,
    })),
    ...systemNodeKinds
      .filter((kind) => kinds.has(kind) === true)
      .map((kind) => ({
        key: `kind:${kind}`,
        label: kind,
        mark: <KitShapeMark shape={shapeOf[kind]} />,
      })),
    ...systemLinkKinds
      .filter((kind) => linkKinds.has(kind) === true)
      .map((kind) => ({ key: `link:${kind}`, label: kind, mark: line("rest", styleOf[kind]) })),
    ...(model.cases.some((item) => item.kind === "replay")
      ? [{ key: "trace", label: "replay path", mark: line("trace") }]
      : []),
    ...(broken
      ? [
          {
            key: "broken",
            label: "broken",
            mark: <span className="tack-legend-swatch" data-broken="" aria-hidden="true" />,
          },
        ]
      : []),
  ];
}

/** Draws a running system from meaning only: no positions, no sizes, no colours, no direction. */
export function System(props: SystemProps): ReactNode {
  const read = useMemo(() => readSystem(props), [props]);
  const { model } = read;
  const laid = useEngineLayout("system", model, layoutSystem);
  const layouts = laid !== undefined && "layouts" in laid ? laid.layouts : undefined;
  const layoutIssues: readonly FigureIssue[] =
    laid === undefined
      ? []
      : "layouts" in laid
        ? systemLayoutIssues(laid.layouts.column)
        : [layoutIssue(`the layout engine failed: ${laid.failure}`)];
  const cases: readonly FrameCase[] = model.cases.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    steps: item.kind === "replay" ? item.steps.length : 0,
  }));
  const ids = useId().replaceAll(":", "");
  const view = useFigureView(model.id, cases, (id) => model.nodes.some((node) => node.id === id));
  const active = model.cases.find((item) => item.id === view.active?.id);
  const name = (id: string): string => systemLabel(model, id);
  const pinned = model.nodes.find((node) => node.id === view.pin);
  const panelCase =
    active === undefined
      ? undefined
      : active.kind === "replay"
        ? {
            kind: "replay" as const,
            label: active.label,
            steps: active.steps.map((step) => ({
              at: step.at.map(name).join(", "),
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
          pinned === undefined ? undefined : <PinnedNode model={model} node={pinned} view={view} />
        }
        hint="Point at a part to see what it sends and receives. Click it, or press Enter, to pin it."
      />
    </div>
  );
  return (
    <FigureFrame
      id={model.id}
      kind="system"
      title={model.title}
      {...(model.summary === undefined ? {} : { summary: model.summary })}
      issues={[...read.issues, ...layoutIssues]}
      readable={[
        systemReadable(model),
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
      className="tack-system"
      controls={<CaseControls cases={cases} view={view} />}
      drawing={(mode) =>
        layouts === undefined ? (
          <p className="tack-figure-pending" role="status">
            {laid === undefined ? "Laying out the figure…" : "The figure could not be laid out."}
          </p>
        ) : (
          <SystemDrawing
            model={model}
            layout={layouts[mode]}
            view={view}
            active={active}
            ids={{
              arrow: `${ids}-${mode}-arrow`,
              hatch: `${ids}-${mode}-hatch`,
              stop: `${ids}-${mode}-stop`,
            }}
          />
        )
      }
      panel={panel}
      legend={<Legend items={legendItems(model)} />}
      onEscape={() => view.release()}
    />
  );
}
