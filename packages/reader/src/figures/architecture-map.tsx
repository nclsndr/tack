/**
 * `ArchitectureMap`: how the code is organised and what may use what, as tiers of boxes. Position
 * carries the rule; links stay hidden until a box is in focus. One inline SVG, states as `data-*`
 * attributes styled by `figures.css`.
 */
import { useId, useMemo } from "react";
import type { ReactNode } from "react";
import { centred, fanSpreads, labelSpot, pointAt, route } from "./curves.ts";
import type { Cubic, Rect } from "./curves.ts";
import {
  CaseControls,
  FigureFrame,
  type FigureView,
  type FrameCase,
  Legend,
  type LegendItem,
  useFigureView,
} from "./frame.tsx";
import { figureLook } from "./look.ts";
import { DetailPanel, PinChips, ReadingPanel, viewLine } from "./panel.tsx";
import { type Ink, KitBadge, KitBox, KitDefs, KitLink, KitLinkLabel } from "./kit.tsx";
import {
  type ArchitectureMapProps,
  type ArchitectureModel,
  architectureReadable,
  type Focus,
  focusOf,
  labelOf,
  type MapCase,
  type MapLink,
  readArchitectureMap,
} from "./architecture-map-model.ts";
import {
  type ArchitectureLayout,
  architectureLayoutIssues,
  columnWidth,
  expandedWidth,
  layoutArchitecture,
} from "./architecture-map-layout.ts";

type CurveKind = "out" | "in" | "onward" | "bundle" | "step";
type Curve = {
  readonly key: string;
  readonly kind: CurveKind;
  readonly curve: Cubic;
  readonly label?: string;
  readonly warning?: MapLink["warning"];
  readonly last?: boolean;
  /** Starts at the focus and points back into it: "used by". */
  readonly incoming?: boolean;
};

/** The tint index of a tier: six quiet tints, in order of appearance. */
const tintOf = (order: number): number => order % 6;

/** The links to draw for a focus: one by one, or one bundle per target tier above the budget. */
function focusCurves(layout: ArchitectureLayout, focusId: string, focus: Focus): readonly Curve[] {
  const hub = layout.boxes.get(focusId);
  if (hub === undefined) return [];
  const bundled = new Set(focus.bundles.map((bundle) => bundle.direction));
  /** A link is drawn on its own unless its direction is bundled and it leaves the focus's tier. */
  const single = (direction: "out" | "in", other: string): boolean =>
    bundled.has(direction) === false || layout.boxes.get(other)?.tier === hub.tier;
  const ends = [
    ...focus.out.map((link) => ({ kind: "out" as const, other: link.to, link })),
    ...focus.incoming.map((link) => ({ kind: "in" as const, other: link.from, link })),
  ].flatMap((end) => {
    const box = layout.boxes.get(end.other);
    return box === undefined || single(end.kind, end.other) === false ? [] : [{ ...end, box }];
  });
  // Each bundle arrives at its own point along its tier, so bundles to far tiers never coincide.
  const bundles = focus.bundles.flatMap((bundle, index) => {
    const area = layout.tiers.get(bundle.tier)?.area;
    if (area === undefined) return [];
    const x = area.x + (area.w * (index + 1)) / (focus.bundles.length + 1);
    return [{ bundle, rect: { x, y: area.y, w: 0, h: area.h } }];
  });
  const spreads = fanSpreads(hub, [
    ...ends.map((end) => end.box),
    ...bundles.map((item) => item.rect),
  ]);
  const linked = ends.map((end, index): Curve => ({
    key: `${end.kind}:${end.other}`,
    kind: end.kind,
    curve: route(hub, end.box, spreads[index] ?? 0),
    incoming: end.kind === "in",
    ...(end.link.label === undefined ? {} : { label: end.link.label }),
    ...(end.link.warning === undefined ? {} : { warning: end.link.warning }),
  }));
  const grouped = bundles.map(({ bundle, rect }, index): Curve => {
    return {
      key: `bundle:${bundle.direction}:${bundle.tier}`,
      kind: "bundle",
      curve: route(hub, rect, spreads[ends.length + index] ?? 0),
      incoming: bundle.direction === "in",
      label: `${bundle.count} ${bundle.direction === "out" ? "uses" : "users"}`,
    };
  });
  const onward = focus.onward.flatMap((link): Curve[] => {
    const from = layout.boxes.get(link.from);
    const to = layout.boxes.get(link.to);
    if (from === undefined || to === undefined) return [];
    const beside = focus.onward.filter((other) => other.from === link.from);
    const into = focus.onward.filter((other) => other.to === link.to);
    return [
      {
        key: `onward:${link.from}:${link.to}`,
        kind: "onward",
        curve: route(
          from,
          to,
          centred(beside.indexOf(link), beside.length, 10),
          centred(into.indexOf(link), into.length, 8),
        ),
      },
    ];
  });
  return [...linked, ...grouped, ...onward];
}

/** The path of a replay so far: one curve between each pair of consecutive steps. */
function stepCurves(
  layout: ArchitectureLayout,
  steps: readonly { readonly at: string }[],
): readonly Curve[] {
  return steps.flatMap((step, index): Curve[] => {
    const from = layout.boxes.get(steps[index - 1]?.at ?? "");
    const to = layout.boxes.get(step.at);
    if (from === undefined || to === undefined || from === to) return [];
    // Leave right of centre and arrive left of it, so a box's way in and way out never share a point.
    return [
      {
        key: `step:${index}`,
        kind: "step",
        curve: route(from, to, 7, -10),
        last: index === steps.length - 1,
      },
    ];
  });
}

type DrawingProps = {
  readonly model: ArchitectureModel;
  readonly layout: ArchitectureLayout;
  readonly view: FigureView;
  readonly activeCase: MapCase | undefined;
  readonly arrow: string;
  readonly hatch: string;
};

/** The map as one SVG: bands, walls, boxes, the links of the focus, replay badges. */
function ArchitectureDrawing({
  model,
  layout,
  view,
  activeCase,
  arrow,
  hatch,
}: DrawingProps): ReactNode {
  const focusId = view.preview ?? (activeCase === undefined ? view.pin : undefined);
  const focus = focusId === undefined ? undefined : focusOf(model, focusId);
  const replay =
    view.preview === undefined && activeCase?.kind === "replay" ? activeCase : undefined;
  const lens = view.preview === undefined && activeCase?.kind === "lens" ? activeCase : undefined;
  const steps = replay === undefined ? [] : replay.steps.slice(0, view.step);
  const current = steps.at(-1)?.at;
  const badges = steps.reduce<ReadonlyMap<string, readonly number[]>>(
    (map, step, index) => new Map([...map, [step.at, [...(map.get(step.at) ?? []), index + 1]]]),
    new Map(),
  );
  const curves = [
    ...(focus === undefined || focusId === undefined ? [] : focusCurves(layout, focusId, focus)),
    ...stepCurves(layout, steps),
  ];
  const lit: readonly Rect[] = [...(focus?.near ?? [])].flatMap((id) => {
    const box = layout.boxes.get(id);
    return box === undefined ? [] : [box];
  });
  const inkOf = (id: string): Ink => {
    if (focus !== undefined)
      return id === focusId
        ? "focus"
        : focus.near.has(id) === true
          ? "near"
          : focus.far.has(id) === true
            ? "far"
            : "off";
    if (replay !== undefined)
      return id === current ? "focus" : badges.has(id) === true ? "visited" : "dim";
    if (lens !== undefined)
      return lens.blocked.includes(id) === true
        ? "blocked"
        : lens.focus.includes(id) === true
          ? "near"
          : "off";
    return undefined;
  };
  const radius = figureLook.boxRadius;
  return (
    <svg
      className="tack-map"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      role="group"
      aria-label={`${model.title}. ${model.nodes.length} boxes in ${model.tiers.length} tiers.`}
      onClick={() => view.release()}
    >
      <KitDefs arrow={arrow} hatch={hatch} />
      {layout.rules.map((y) => (
        <line
          key={y}
          className="tack-map-rule"
          x1={0}
          x2={layout.width}
          y1={y + 0.5}
          y2={y + 0.5}
        />
      ))}
      {layout.walls.map((wall) => (
        <g
          key={wall.x}
          className="tack-map-wall"
          data-barrier={wall.label === undefined ? undefined : ""}
        >
          <line x1={wall.x} x2={wall.x} y1={wall.y1} y2={wall.y2} />
          {wall.label === undefined ? null : (
            <text x={wall.x} y={wall.labelY} textAnchor="middle">
              {wall.label}
            </text>
          )}
        </g>
      ))}
      {[...layout.tiers.values()].map((tier) => (
        <g key={tier.id} className="tack-map-tier" data-tint={tintOf(tier.order)}>
          {tier.header.map((line, index) => (
            <text
              key={index}
              className={`tack-map-${line.kind}`}
              x={line.kind === "label" ? line.x + 13 : line.x}
              y={line.y}
            >
              {line.text}
            </text>
          ))}
          {tier.header[0] === undefined ? null : (
            <rect
              className="tack-map-swatch"
              x={tier.header[0].x + 0.5}
              y={tier.header[0].y - 8.5}
              width={8}
              height={8}
              rx={Math.min(radius, 2)}
            />
          )}
        </g>
      ))}
      <g className="tack-map-links">
        {curves.map((curve) => (
          <KitLink
            key={curve.key}
            curve={curve.curve}
            kind={curve.kind}
            arrow={arrow}
            incoming={curve.incoming === true}
            warning={curve.warning}
            last={curve.last === true}
          />
        ))}
      </g>
      {model.tiers.flatMap((tier) =>
        tier.nodes.map((node) => {
          const box = layout.boxes.get(node.id);
          if (box === undefined) return null;
          return (
            <KitBox
              key={node.id}
              id={node.id}
              x={box.x}
              y={box.y}
              w={box.w}
              h={box.h}
              text={box.text}
              {...(box.detailText === undefined ? {} : { detailText: box.detailText })}
              label={node.label}
              {...(node.detail === undefined ? {} : { detail: node.detail })}
              tint={tintOf(tier.order)}
              ink={inkOf(node.id)}
              view={view}
              hatch={hatch}
            />
          );
        }),
      )}
      <g className="tack-map-marks" aria-hidden="true">
        {curves.map((curve) => {
          // A bundle's count is the only place its size shows, so it is drawn even where it is crowded.
          const spot =
            curve.label === undefined
              ? undefined
              : (labelSpot(curve.curve, curve.label.length, lit) ??
                (curve.kind === "bundle" ? pointAt(curve.curve, 0.5) : undefined));
          return spot === undefined || curve.label === undefined ? null : (
            <KitLinkLabel key={curve.key} x={spot[0]} y={spot[1]} kind={curve.kind}>
              {curve.label}
            </KitLinkLabel>
          );
        })}
        {[...badges].flatMap(([id, numbers]) => {
          const box = layout.boxes.get(id);
          if (box === undefined) return [];
          return numbers.map((number, index) => (
            <KitBadge key={number} x={Math.round(box.x) + 14 + index * 20} y={box.y} n={number} />
          ));
        })}
      </g>
    </svg>
  );
}

/** The details of the pinned box: its tier, its text, and what it uses and is used by. */
function PinnedNode({
  model,
  view,
}: {
  readonly model: ArchitectureModel;
  readonly view: FigureView;
}): ReactNode {
  const pinned = model.nodes.find((node) => node.id === view.pin);
  if (pinned === undefined) return null;
  const tier = model.tiers.find((candidate) => candidate.id === pinned.tier);
  const nodeLinks = model.links.filter((link) => link.level === "node");
  const chips = (title: "Uses" | "Used by") =>
    nodeLinks
      .filter((link) => (title === "Uses" ? link.from : link.to) === pinned.id)
      .map((link) => {
        const other = title === "Uses" ? link.to : link.from;
        return {
          id: other,
          label: labelOf(model, other),
          ...(link.label === undefined ? {} : { note: link.label }),
        };
      });
  return (
    <>
      <h4 className="tack-figure-key">Pinned, in {tier?.label ?? ""}</h4>
      <p className="tack-figure-who">
        <strong>{pinned.label}</strong>
        {pinned.detail === undefined ? null : <code>{pinned.detail}</code>}
      </p>
      {pinned.about === undefined ? null : <p>{pinned.about}</p>}
      <PinChips title="Uses" entries={chips("Uses")} view={view} />
      <PinChips title="Used by" entries={chips("Used by")} view={view} />
    </>
  );
}

/** The legend items the map's data calls for. */
function legendItems(model: ArchitectureModel): readonly LegendItem[] {
  const line = (kind: string): ReactNode => (
    <svg className="tack-legend-mark" width="22" height="8" aria-hidden="true">
      <line x1="1" x2="21" y1="4" y2="4" className="tack-map-link" data-kind={kind} />
    </svg>
  );
  return [
    ...model.tiers.map((tier) => ({
      key: `tier:${tier.id}`,
      label: tier.label,
      mark: (
        <span className="tack-legend-swatch" data-tint={tintOf(tier.order)} aria-hidden="true" />
      ),
    })),
    { key: "uses", label: "uses", mark: line("out") },
    { key: "used-by", label: "used by", mark: line("in") },
    { key: "onward", label: "one further use", mark: line("onward") },
    ...(model.cases.some((item) => item.kind === "replay") === true
      ? [{ key: "step", label: "replay path", mark: line("step") }]
      : []),
    ...(model.cases.some((item) => item.kind === "lens" && item.blocked.length > 0) === true
      ? [
          {
            key: "blocked",
            label: "blocked",
            mark: <span className="tack-legend-swatch" data-blocked="" aria-hidden="true" />,
          },
        ]
      : []),
    ...(model.links.some((link) => link.warning !== undefined) === true
      ? [{ key: "warning", label: "against the rule", mark: line("warning") }]
      : []),
  ];
}

const frameCases = (model: ArchitectureModel): readonly FrameCase[] =>
  model.cases.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    steps: item.kind === "replay" ? item.steps.length : 0,
  }));

/** Draws the architecture of a codebase as tiers, from meaning only: no positions, no colours. */
export function ArchitectureMap(props: ArchitectureMapProps): ReactNode {
  const read = useMemo(() => readArchitectureMap(props), [props]);
  const { model } = read;
  const layouts = useMemo(
    () => ({
      column: layoutArchitecture(model, columnWidth),
      expanded: layoutArchitecture(model, expandedWidth),
    }),
    [model],
  );
  const issues = [...read.issues, ...architectureLayoutIssues(layouts.column)];
  const cases = frameCases(model);
  const ids = useId().replaceAll(":", "");
  const view = useFigureView(model.id, cases, (id) => model.nodes.some((node) => node.id === id));
  const activeCase = model.cases.find((item) => item.id === view.active?.id);
  const panel = (
    <div className="tack-figure-panel">
      <ReadingPanel
        rule={model.rule}
        startWith={model.startWith.map((id) => ({ id, label: labelOf(model, id) }))}
        view={view}
      />
      <DetailPanel
        active={activeCase}
        view={view}
        labelOf={(id) => labelOf(model, id)}
        pinned={view.pin === undefined ? undefined : <PinnedNode model={model} view={view} />}
        hint="Point at a box to see its links. Click it, or press Enter, to pin it."
      />
    </div>
  );
  return (
    <FigureFrame
      id={model.id}
      kind="architecture"
      title={model.title}
      {...(model.summary === undefined ? {} : { summary: model.summary })}
      issues={issues}
      readable={[
        architectureReadable(model),
        viewLine(
          activeCase === undefined
            ? undefined
            : {
                kind: activeCase.kind,
                label: activeCase.label,
                ...(activeCase.kind === "replay" ? { steps: activeCase.steps.length } : {}),
              },
          view,
          (id) => labelOf(model, id),
        ),
      ]
        .filter((line) => line !== "")
        .join("\n")}
      state={view.state}
      className="tack-architecture-map"
      controls={<CaseControls cases={cases} view={view} />}
      drawing={(mode) => (
        <ArchitectureDrawing
          model={model}
          layout={layouts[mode]}
          view={view}
          activeCase={activeCase}
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
