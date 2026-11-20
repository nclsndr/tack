/**
 * The kit's drawing parts as SVG: markers, boxes, links, link labels and badges. The catalog
 * components and authored figures draw with these, so a style or a state fixed here is fixed in
 * both. States are `data-*` attributes styled by `figures.css`.
 */
import type { ReactNode } from "react";
import { type Cubic, cubicPath } from "./curves.ts";
import type { FigureView } from "./frame.tsx";
import { figureLook } from "./look.ts";

/** How a box is inked: by the focus, a replay or a lens. `undefined` at rest. */
export type Ink =
  | "focus"
  | "near"
  | "far"
  | "off"
  | "visited"
  | "dim"
  | "blocked"
  | "broken"
  | undefined;

/** The shapes a box can take. */
export type KitShape = "plain" | "store" | "queue" | "external" | "actor" | "sheet";

/** The arrowhead and the hatch, once per drawing. Ids must be unique on the page. */
export function KitDefs({
  arrow,
  hatch,
  stop,
}: {
  readonly arrow: string;
  readonly hatch: string;
  /** The stop mark that ends a broken link, for drawings that have one. */
  readonly stop?: string;
}): ReactNode {
  return (
    <defs>
      {/* One arrowhead for every ink: `context-stroke` takes the colour of the path. */}
      <marker
        id={arrow}
        viewBox="0 0 8 8"
        markerWidth="8"
        markerHeight="8"
        refX="6"
        refY="4"
        orient="auto-start-reverse"
        markerUnits="userSpaceOnUse"
      >
        <path d="M1.2 1.4 L7 4 L1.2 6.6 Z" fill="context-stroke" stroke="context-stroke" />
      </marker>
      <pattern
        id={hatch}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line x1="0" y1="0" x2="0" y2="6" className="tack-map-hatch" />
      </pattern>
      {stop === undefined ? null : (
        <marker
          id={stop}
          viewBox="0 0 8 14"
          markerWidth="8"
          markerHeight="14"
          refX="4"
          refY="7"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M4 1 V13" stroke="context-stroke" strokeWidth="2.5" strokeLinecap="round" />
        </marker>
      )}
    </defs>
  );
}

/** The outline of a box of `shape`, `w` by `h`, at the origin. */
function Outline({
  shape,
  w,
  h,
}: {
  readonly shape: KitShape;
  readonly w: number;
  readonly h: number;
}): ReactNode {
  const radius = figureLook.boxRadius;
  switch (shape) {
    case "store": {
      // A cylinder: the top rim is an ellipse, the sides are straight.
      const ry = 4;
      return (
        <>
          <path
            className="tack-map-shape"
            d={`M0 ${ry} A ${w / 2} ${ry} 0 0 1 ${w} ${ry} V ${h - ry} A ${w / 2} ${ry} 0 0 1 0 ${h - ry} Z`}
          />
          <path className="tack-map-rim" d={`M0 ${ry} A ${w / 2} ${ry} 0 0 0 ${w} ${ry}`} />
        </>
      );
    }
    case "queue":
      return (
        <>
          <rect className="tack-map-shape" width={w} height={h} rx={radius} />
          {[14, 10, 6].map((offset) => (
            <line
              key={offset}
              className="tack-map-rim"
              x1={w - offset}
              x2={w - offset}
              y1={5}
              y2={h - 5}
            />
          ))}
        </>
      );
    case "actor":
      return <rect className="tack-map-shape" width={w} height={h} rx={h / 2} />;
    case "sheet": {
      const fold = 8;
      return (
        <>
          <path className="tack-map-shape" d={`M0 0 H ${w - fold} L ${w} ${fold} V ${h} H 0 Z`} />
          <path className="tack-map-rim" d={`M${w - fold} 0 V ${fold} H ${w}`} />
        </>
      );
    }
    case "plain":
    case "external":
      return <rect className="tack-map-shape" width={w} height={h} rx={radius} />;
    // Coverage skip: the compiler proves every shape is handled; this arm cannot run.
    /* v8 ignore next 4 -- @preserve */
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/** A small picture of a box shape, for a legend. */
export function KitShapeMark({ shape }: { readonly shape: KitShape }): ReactNode {
  return (
    <svg
      className="tack-legend-mark tack-map-box"
      data-shape={shape}
      width="24"
      height="16"
      viewBox="-1 -1 26 18"
      aria-hidden="true"
    >
      <Outline shape={shape} w={24} h={16} />
    </svg>
  );
}

/**
 * What makes a part of a drawing a box the viewer can use: focusable, previewed on pointer or
 * keyboard focus, pinned on click, Enter or Space.
 */
export function kitBoxHandlers(view: FigureView, id: string, label: string) {
  return {
    tabIndex: 0,
    role: "button",
    "aria-pressed": view.pin === id,
    "aria-label": label,
    onMouseEnter: () => view.setPreview(id),
    onMouseLeave: () => view.setPreview(undefined),
    onFocus: () => view.setPreview(id),
    onBlur: () => view.setPreview(undefined),
    onClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      view.togglePin(id);
    },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      view.togglePin(id);
    },
  } as const;
}

export type KitBoxProps = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The label as drawn, already fitted. */
  readonly text: string;
  readonly detailText?: string;
  /** Mono lines under the label and detail: table names, sub-parts, settings. */
  readonly lines?: readonly string[];
  /** How far the text sits below the top: under a store's rim. */
  readonly top?: number;
  /** The full label and detail, for the tooltip and assistive technology. */
  readonly label: string;
  readonly detail?: string;
  readonly tint?: number;
  readonly shape?: KitShape;
  readonly ink: Ink;
  readonly view: FigureView;
  /** The hatch pattern id, for a blocked box. */
  readonly hatch: string;
  /** False for a box that takes part in no focus: drawn, not operable. */
  readonly interactive?: boolean;
};

/** A named part of a drawing: focusable, previewed on pointer or keyboard, pinned on click or Enter. */
export function KitBox(props: KitBoxProps): ReactNode {
  const radius = figureLook.boxRadius;
  // Snap the outline to half pixels so the 1 px border stays crisp at 1:1.
  const x = Math.round(props.x) + 0.5;
  const w = Math.round(props.x + props.w) - 0.5 - x;
  const h = props.h - 1;
  const shape = props.shape ?? "plain";
  const { view, id } = props;
  const title = `${props.label}${props.detail === undefined ? "" : ` (${props.detail})`}`;
  const handlers =
    props.interactive === false
      ? {}
      : kitBoxHandlers(
          view,
          id,
          `${props.label}${props.detail === undefined ? "" : `, ${props.detail}`}`,
        );
  const lines = props.lines ?? [];
  const top = props.top ?? (shape === "store" ? 2 : 0);
  const labelY = props.detailText === undefined && lines.length === 0 ? h / 2 + 4.5 : 19;
  const linesFrom = (props.detailText === undefined ? 19 : 35) + 15;
  return (
    <g
      className="tack-map-box"
      data-box={id}
      data-tint={props.tint}
      data-ink={props.ink}
      data-shape={shape}
      data-pinned={view.pin === id ? "" : undefined}
      transform={`translate(${x} ${props.y + 0.5})`}
      {...handlers}
    >
      <title>{title}</title>
      <rect className="tack-map-ring" x={-3} y={-3} width={w + 6} height={h + 6} rx={radius + 3} />
      <Outline shape={shape} w={w} h={h} />
      {props.ink === "blocked" ? (
        <rect
          width={w}
          height={h}
          rx={radius}
          fill={`url(#${props.hatch})`}
          className="tack-map-blocked"
        />
      ) : null}
      <text className="tack-map-label" x={8} y={labelY + top}>
        {props.text}
      </text>
      {props.detailText === undefined ? null : (
        <text className="tack-map-detail" x={8} y={35 + (props.top ?? 0)}>
          {props.detailText}
        </text>
      )}
      {lines.map((line, index) => (
        <text
          key={index}
          className="tack-map-detail tack-map-line"
          x={8}
          y={linesFrom + index * 15 + (props.top ?? 0)}
        >
          {line}
        </text>
      ))}
      {props.ink === "broken" ? (
        <line className="tack-map-strike" x1={4} x2={w - 4} y1={h / 2} y2={h / 2} />
      ) : null}
    </g>
  );
}

export type KitCurveKind =
  | "out"
  | "in"
  | "onward"
  | "bundle"
  | "step"
  | "rest"
  | "fade"
  | "trace"
  | "broken";

/** A link: one smooth curve with an arrowhead at its end, or at its start for "used by". */
export function KitLink({
  curve,
  kind,
  arrow,
  incoming = false,
  warning,
  last = false,
  style,
  stop,
  link,
}: {
  readonly curve: Cubic;
  readonly kind: KitCurveKind;
  /** The arrowhead's id; a link without one, such as a relation, has no arrowhead. */
  readonly arrow?: string;
  readonly incoming?: boolean;
  readonly warning?: string | undefined;
  readonly last?: boolean;
  /** The line style: an authored link's style, or what a `System` link's kind sets. */
  readonly style?: string;
  /** The stop mark that ends a broken link instead of an arrowhead. */
  readonly stop?: string;
  /** The id of the link this curve draws, when it has one. */
  readonly link?: string;
}): ReactNode {
  const end = kind === "broken" && stop !== undefined ? stop : arrow;
  const outgoing = incoming === false;
  const marker = (at: boolean): string | undefined =>
    at && end !== undefined ? `url(#${end})` : undefined;
  return (
    <path
      className="tack-map-link"
      data-kind={kind}
      data-link={link}
      data-style={style}
      data-warning={warning}
      data-last={last ? "" : undefined}
      d={cubicPath(curve)}
      pathLength={kind === "step" ? 1 : undefined}
      markerStart={marker(incoming)}
      markerEnd={marker(outgoing)}
    />
  );
}

/** A link's label, on the link, with a halo in the ground colour. */
export function KitLinkLabel({
  x,
  y,
  kind,
  children,
}: {
  readonly x: number;
  readonly y: number;
  readonly kind: KitCurveKind;
  readonly children: string;
}): ReactNode {
  return (
    <text className="tack-map-link-label" data-kind={kind} textAnchor="middle" x={x} y={y + 3.5}>
      {children}
    </text>
  );
}

/** A numbered mark at a point: a replay step, or an author's badge. */
export function KitBadge({
  x,
  y,
  n,
}: {
  readonly x: number;
  readonly y: number;
  readonly n: number;
}): ReactNode {
  return (
    <g className="tack-map-badge" transform={`translate(${x} ${y})`}>
      <circle r={9} />
      <text textAnchor="middle" y={3.8}>
        {n}
      </text>
    </g>
  );
}
