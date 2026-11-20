/**
 * Authored figures: the frame plus a drawing the author composes from kit elements at explicit
 * positions, for the figure no catalog component fits. The kit elements render nothing on their
 * own: `Figure` reads them as data, checks them like the figure check does, and draws them with
 * the frame's focus, cases, panel, legend, text equivalent and view state. The author writes no
 * handler.
 */
import { Children, Fragment, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { labelSpot, type Rect } from "./curves.ts";
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
  KitDefs,
  KitLink,
  type KitCurveKind,
  KitLinkLabel,
} from "./kit.tsx";
import type { FigureProps } from "./authored-model.ts";
import {
  type AuthoredCase,
  type AuthoredElement,
  type AuthoredModel,
  authoredBudget,
  authoredLabel,
  authoredReadable,
  authoredText,
  type BoxShape,
  type KitElementName,
  kitElements,
  linkCurve,
  oneOf,
  type LinkStyle,
  readAuthoredFigure,
} from "./authored-model.ts";
import { fitText } from "./architecture-map-layout.ts";

export type DrawingProps = { readonly height: number; readonly children?: ReactNode };
export type BoxProps = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly detail?: string;
  readonly about?: string;
  /** 1 to 6: one of the six quiet tints. */
  readonly tint?: number;
  readonly shape?: BoxShape;
  /** A width, when the text-derived width is not wanted. */
  readonly w?: number;
};
export type LinkProps = {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly style?: LinkStyle;
};
export type BandProps = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly tint?: number;
};
export type BadgeProps = { readonly at: string; readonly n: number };
export type NoteProps = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** A box id to point at, or `toX` and `toY`. */
  readonly to?: string;
  readonly toX?: number;
  readonly toY?: number;
};
export type LabelProps = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size?: "large" | "small";
  readonly anchor?: "start" | "middle" | "end";
};

export type { FigureProps } from "./authored-model.ts";

/** The property that names the element kind a kit component stands for. */
const kitTag = "tackKit";

/** A kit component: data for `Figure`, so on its own it draws nothing. */
const kit = (name: KitElementName, label: string): ((props: unknown) => ReactNode) =>
  Object.assign((): ReactNode => null, { [kitTag]: name, displayName: label });

/** The picture of an authored figure. Always 728 wide; the author gives the height. */
export const Drawing = Object.assign((_props: DrawingProps): ReactNode => null, {
  displayName: "Drawing",
});
/** A named part at `x`, `y`. Its width follows from its text unless `w` is given. */
export const Box: (props: BoxProps) => ReactNode = kit("box", "Box");
/** A curve from one box to another. The kit routes it and places the arrowhead. */
export const Link: (props: LinkProps) => ReactNode = kit("link", "Link");
/** A labelled region: a tier, a boundary, a swimlane. */
export const Band: (props: BandProps) => ReactNode = kit("band", "Band");
/** A numbered mark on a box. */
export const Badge: (props: BadgeProps) => ReactNode = kit("badge", "Badge");
/** A short annotation with a leader line to a box or a point. */
export const Note: (props: NoteProps) => ReactNode = kit("note", "Note");
/** Free text in one of the two drawing sizes. */
export const Label: (props: LabelProps) => ReactNode = kit("label", "Label");

/** The elements under `node`, with fragments and arrays opened. */
type ElementProps = Readonly<Record<string, unknown>> & { readonly children?: ReactNode };

function elementsOf(node: ReactNode): readonly ReactElement<ElementProps>[] {
  return Children.toArray(node).flatMap((child) => {
    if (isValidElement<ElementProps>(child) === false) return [];
    if (child.type === Fragment) return elementsOf(child.props.children);
    return [child];
  });
}

/** The drawing's elements as data, and the raw SVG to render, in the author's order. */
function readDrawing(children: ReactNode): {
  readonly height: unknown;
  readonly elements: readonly AuthoredElement[];
  readonly raw: readonly ReactElement[];
  readonly found: boolean;
} {
  const drawing = elementsOf(children).find((child) => child.type === Drawing);
  if (drawing === undefined) return { height: undefined, elements: [], raw: [], found: false };
  const inner = elementsOf(drawing.props.children);
  const tagOf = (element: ReactElement): KitElementName => {
    const tag: unknown =
      typeof element.type === "string" ? undefined : Reflect.get(element.type, kitTag);
    return oneOf(kitElements, tag) === true ? tag : "raw";
  };
  return {
    height: drawing.props["height"],
    elements: inner.map((element) => {
      const { children: _children, ...props } = element.props;
      return { element: tagOf(element), props };
    }),
    raw: inner.filter((element) => tagOf(element) === "raw"),
    found: true,
  };
}

/** A note's leader: from the end of its text nearest the target, to the target. */
function leader(
  note: AuthoredModel["notes"][number],
): Readonly<Record<"x1" | "y1" | "x2" | "y2", number>> {
  const to = note.to ?? { x: note.x, y: note.y };
  const width = note.text.length * authoredText.small.char;
  const middle = note.y - 4;
  const start =
    to.x > note.x + width
      ? { x1: note.x + width + 4, y1: middle }
      : to.x < note.x
        ? { x1: note.x - 4, y1: middle }
        : { x1: note.x + width / 2, y1: to.y < note.y ? note.y - 14 : note.y + 4 };
  return { ...start, x2: to.x, y2: to.y };
}

/** Where a band's label is drawn: small caps at its top left. */
const bandLabelRect = (band: {
  readonly x: number;
  readonly y: number;
  readonly label: string;
}): Rect => ({
  x: band.x + 10,
  y: band.y + 6,
  w: band.label.length * 7.6,
  h: 14,
});

type Curve = {
  readonly key: string;
  readonly kind: KitCurveKind;
  readonly curve: AuthoredModel["links"][number]["curve"];
  readonly label?: string;
  readonly style?: LinkStyle;
  readonly incoming?: boolean;
  readonly last?: boolean;
};

function AuthoredDrawing({
  model,
  raw,
  view,
  active,
  arrow,
  hatch,
}: {
  readonly model: AuthoredModel;
  readonly raw: readonly ReactElement[];
  readonly view: FigureView;
  readonly active: AuthoredCase | undefined;
  readonly arrow: string;
  readonly hatch: string;
}): ReactNode {
  const focus = view.preview ?? (active === undefined ? view.pin : undefined);
  const replay = view.preview === undefined && active?.kind === "replay" ? active : undefined;
  const lens = view.preview === undefined && active?.kind === "lens" ? active : undefined;
  const steps = replay === undefined ? [] : replay.steps.slice(0, view.step);
  const current = steps.at(-1)?.at;
  const near = new Set(
    focus === undefined
      ? []
      : model.links.flatMap((link) =>
          link.from === focus ? [link.to] : link.to === focus ? [link.from] : [],
        ),
  );
  const boxById = new Map(model.boxes.map((box) => [box.id, box]));
  const inkOf = (id: string): Ink => {
    if (focus !== undefined) return id === focus ? "focus" : near.has(id) ? "near" : "off";
    if (replay !== undefined)
      return id === current ? "focus" : steps.some((step) => step.at === id) ? "visited" : "dim";
    if (lens?.kind === "lens") {
      if (lens.broken.includes(id)) return "broken";
      if (lens.blocked.includes(id)) return "blocked";
      return lens.focus.includes(id) ? "near" : "off";
    }
    return undefined;
  };
  const atRest = model.boxes.length <= authoredBudget.linksAtRestUpTo;
  const linkCurves = model.links.flatMap((link): Curve[] => {
    const label = link.label ?? model.legend[link.style];
    const base = {
      key: `${link.from}:${link.to}`,
      curve: link.curve,
      style: link.style,
      ...(label === undefined ? {} : { label }),
    };
    if (focus !== undefined) {
      if (link.from === focus) return [{ ...base, kind: "out" }];
      if (link.to === focus) return [{ ...base, kind: "in" }];
      return atRest ? [{ ...base, kind: "fade" }] : [];
    }
    if (replay !== undefined || lens !== undefined)
      return atRest ? [{ ...base, kind: "fade" }] : [];
    return atRest ? [{ ...base, kind: "rest" }] : [];
  });
  const stepCurves = steps.flatMap((step, index): Curve[] => {
    const from = boxById.get(steps[index - 1]?.at ?? "");
    const to = boxById.get(step.at);
    if (from === undefined || to === undefined || from === to) return [];
    return [
      {
        key: `step:${index}`,
        kind: "step",
        curve: linkCurve(from, to, 7),
        last: index === steps.length - 1,
      },
    ];
  });
  const curves = [...linkCurves, ...stepCurves];
  // Link labels stay clear of the lit boxes and of every band's label.
  const lit: readonly Rect[] = [
    ...model.boxes.filter((box) => inkOf(box.id) !== "off"),
    ...model.bands.map((band) => bandLabelRect(band)),
  ];
  const badges = steps.reduce<ReadonlyMap<string, readonly number[]>>(
    (map, step, index) => new Map([...map, [step.at, [...(map.get(step.at) ?? []), index + 1]]]),
    new Map(),
  );
  return (
    <svg
      className="tack-map tack-authored"
      viewBox={`0 0 728 ${model.height}`}
      width={728}
      role="group"
      aria-label={`${model.title}. ${model.boxes.length} boxes.`}
      onClick={() => view.release()}
    >
      <KitDefs arrow={arrow} hatch={hatch} />
      {model.bands.map((band, index) => (
        <g key={index} className="tack-kit-band" data-tint={band.tint}>
          <rect x={band.x + 0.5} y={band.y + 0.5} width={band.w - 1} height={band.h - 1} rx={3} />
          <text x={band.x + 10} y={band.y + 17}>
            {band.label}
          </text>
        </g>
      ))}
      <g
        className="tack-kit-raw"
        data-dim={focus !== undefined || active !== undefined ? "" : undefined}
      >
        {raw}
      </g>
      <g className="tack-map-links">
        {curves.map((curve) => (
          <KitLink
            key={curve.key}
            curve={curve.curve}
            kind={curve.kind}
            arrow={arrow}
            {...(curve.style === undefined ? {} : { style: curve.style })}
            last={curve.last === true}
          />
        ))}
      </g>
      {model.notes.map((note, index) => (
        <g key={index} className="tack-kit-note">
          {note.to === undefined ? null : <line {...leader(note)} />}
          <text x={note.x} y={note.y}>
            {note.text}
          </text>
        </g>
      ))}
      {model.boxes.map((box) => {
        const room = box.w - 16;
        return (
          <KitBox
            key={box.id}
            id={box.id}
            x={box.x}
            y={box.y}
            w={box.w}
            h={box.h}
            text={fitText(box.label, room, authoredText.label.char)}
            {...(box.detail === undefined
              ? {}
              : { detailText: fitText(box.detail, room, authoredText.detail.char) })}
            label={box.label}
            {...(box.detail === undefined ? {} : { detail: box.detail })}
            {...(box.tint === undefined ? {} : { tint: box.tint })}
            shape={box.shape}
            ink={inkOf(box.id)}
            view={view}
            hatch={hatch}
            interactive={box.named}
          />
        );
      })}
      {model.labels.map((label, index) => (
        <text
          key={index}
          className="tack-kit-label"
          data-size={label.size}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
        >
          {label.text}
        </text>
      ))}
      <g className="tack-map-marks" aria-hidden="true">
        {curves.map((curve) => {
          if (curve.label === undefined || curve.kind === "fade") return null;
          const spot = labelSpot(curve.curve, curve.label.length, lit);
          return spot === undefined ? null : (
            <KitLinkLabel key={curve.key} x={spot[0]} y={spot[1]} kind={curve.kind}>
              {curve.label}
            </KitLinkLabel>
          );
        })}
        {model.badges.map((badge) => {
          const box = boxById.get(badge.at);
          return box === undefined ? null : (
            <KitBadge
              key={`badge:${badge.at}:${badge.n}`}
              x={Math.round(box.x)}
              y={box.y}
              n={badge.n}
            />
          );
        })}
        {[...badges].flatMap(([id, numbers]) => {
          const box = boxById.get(id);
          if (box === undefined) return [];
          return numbers.map((n, index) => (
            <KitBadge key={`step:${n}`} x={Math.round(box.x) + 14 + index * 20} y={box.y} n={n} />
          ));
        })}
      </g>
    </svg>
  );
}

function legendItems(model: AuthoredModel): readonly LegendItem[] {
  const line = (kind: string, style?: string): ReactNode => (
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
  const styles = [...new Set(model.links.map((link) => link.style))];
  const tints = [
    ...new Set(model.boxes.flatMap((box) => (box.tint === undefined ? [] : [box.tint]))),
  ].toSorted((a, b) => a - b);
  const shapes = [...new Set(model.boxes.map((box) => box.shape))].filter(
    (shape) => shape !== "plain",
  );
  const named = (key: string): string | undefined => model.legend[key];
  return [
    ...tints.flatMap((tint) => {
      const label = named(`tint-${tint + 1}`);
      return label === undefined
        ? []
        : [
            {
              key: `tint-${tint}`,
              label,
              mark: <span className="tack-legend-swatch" data-tint={tint} aria-hidden="true" />,
            },
          ];
    }),
    ...shapes.flatMap((shape) => {
      const label = named(shape);
      return label === undefined
        ? []
        : [
            {
              key: `shape-${shape}`,
              label,
              mark: <span className="tack-legend-swatch" data-shape={shape} aria-hidden="true" />,
            },
          ];
    }),
    ...styles.flatMap((style) => {
      const label = named(style);
      return label === undefined
        ? []
        : [{ key: `style-${style}`, label, mark: line("rest", style) }];
    }),
    ...(model.cases.some((item) => item.kind === "replay")
      ? [{ key: "step", label: "replay path", mark: line("step") }]
      : []),
    ...(model.cases.some((item) => item.kind === "lens" && item.blocked.length > 0)
      ? [
          {
            key: "blocked",
            label: "blocked",
            mark: <span className="tack-legend-swatch" data-blocked="" aria-hidden="true" />,
          },
        ]
      : []),
    ...(model.cases.some((item) => item.kind === "lens" && item.broken.length > 0)
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

function PinnedBox({
  model,
  view,
}: {
  readonly model: AuthoredModel;
  readonly view: FigureView;
}): ReactNode {
  const box = model.boxes.find((item) => item.id === view.pin);
  if (box === undefined) return null;
  const label = (id: string): string => authoredLabel(model, id);
  const named = (link: AuthoredModel["links"][number]): string | undefined =>
    link.label ?? model.legend[link.style];
  return (
    <>
      <h4 className="tack-figure-key">Pinned</h4>
      <p className="tack-figure-who">
        <strong>{box.label}</strong>
        {box.detail === undefined ? null : <code>{box.detail}</code>}
      </p>
      {box.about === undefined ? null : <p>{box.about}</p>}
      <PinChips
        title="Uses"
        entries={model.links
          .filter((link) => link.from === box.id)
          .map((link) => ({
            id: link.to,
            label: label(link.to),
            ...(named(link) === undefined ? {} : { note: named(link) ?? "" }),
          }))}
        view={view}
      />
      <PinChips
        title="Used by"
        entries={model.links
          .filter((link) => link.to === box.id)
          .map((link) => ({
            id: link.from,
            label: label(link.from),
            ...(named(link) === undefined ? {} : { note: named(link) ?? "" }),
          }))}
        view={view}
      />
    </>
  );
}

/**
 * The frame around a drawing an author composes from kit elements. Takes the frame's props, and a
 * `Drawing` of `Box`, `Link`, `Band`, `Badge`, `Note`, `Label` and raw SVG as children.
 */
export function Figure(props: FigureProps): ReactNode {
  const { children, ...frameProps } = props;
  // Cheap and pure: read on every render, so the drawing follows its children.
  const drawing = readDrawing(children);
  const read = readAuthoredFigure({
    ...frameProps,
    ...(drawing.found ? { drawing: { height: drawing.height, elements: drawing.elements } } : {}),
  });
  const { model } = read;
  const cases: readonly FrameCase[] = model.cases.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    steps: item.kind === "replay" ? item.steps.length : 0,
  }));
  const ids = useId().replaceAll(":", "");
  const view = useFigureView(model.id, cases, (id) =>
    model.boxes.some((box) => box.named && box.id === id),
  );
  const active = model.cases.find((item) => item.id === view.active?.id);
  const label = (id: string): string => authoredLabel(model, id);
  const panel = (
    <div className="tack-figure-panel">
      <ReadingPanel
        rule={model.rule}
        startWith={model.startWith.map((id) => ({ id, label: label(id) }))}
        view={view}
      />
      <DetailPanel
        active={active}
        view={view}
        labelOf={label}
        pinned={view.pin === undefined ? undefined : <PinnedBox model={model} view={view} />}
        hint="Point at a box to see its links. Click it, or press Enter, to pin it."
      />
    </div>
  );
  return (
    <FigureFrame
      id={model.id}
      kind={model.kind}
      title={model.title}
      {...(model.summary === undefined ? {} : { summary: model.summary })}
      issues={read.issues}
      readable={[
        authoredReadable(model),
        viewLine(
          active === undefined
            ? undefined
            : {
                kind: active.kind,
                label: active.label,
                ...(active.kind === "replay" ? { steps: active.steps.length } : {}),
              },
          view,
          label,
        ),
      ]
        .filter((line) => line !== "")
        .join("\n")}
      state={view.state}
      className="tack-authored-figure"
      controls={<CaseControls cases={cases} view={view} />}
      drawing={(mode) => (
        <AuthoredDrawing
          model={model}
          raw={drawing.raw}
          view={view}
          active={active}
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
