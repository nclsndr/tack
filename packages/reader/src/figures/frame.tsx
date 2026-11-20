/**
 * The figure frame: everything a figure has around its drawing. Caption and summary are text on
 * the page; the drawing sits on its ground; the panel, legend and issue list follow. The frame
 * works from ids and labels only, so every figure component reuses it unchanged.
 */
import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { markdownPass } from "../markdown-pass.ts";
import { numericState, useVisualState } from "../state.ts";
import { type FigureIssue, issueLine } from "./issues.ts";
import { type FigureKind, lookAttributes } from "./look.ts";

/** A situation shown on the drawing: an ordered replay or an unordered lens. */
export type FrameCase = {
  readonly id: string;
  readonly label: string;
  readonly kind: "replay" | "lens";
  /** The number of steps of a replay; 0 for a lens. */
  readonly steps: number;
};

/** The view state of a figure: in the URL, reproduced by a copied block. */
export type FigureView = {
  readonly pin: string | undefined;
  readonly active: FrameCase | undefined;
  /** 1-based step of the active replay; 0 otherwise. */
  readonly step: number;
  /** The box under the pointer or keyboard focus; never in the URL. */
  readonly preview: string | undefined;
  /** What a copied block carries. */
  readonly state: {
    readonly pin: string | null;
    readonly case: string | null;
    readonly step: number | null;
  };
  readonly togglePin: (id: string) => void;
  readonly release: () => void;
  readonly toggleCase: (id: string) => void;
  readonly goToStep: (step: number) => void;
  readonly setPreview: (id: string | undefined) => void;
};

/**
 * Pin, case and step live in the URL; the preview is local. Pinning leaves any case, and picking a
 * case drops the pin: one of them is active at a time.
 */
export function useFigureView(
  id: string,
  cases: readonly FrameCase[],
  isBox: (id: string) => boolean,
): FigureView {
  const [state, update] = useVisualState(id);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const active = cases.find((item) => item.id === state["case"]);
  const pinned = state["pin"];
  const pin =
    active === undefined && pinned !== undefined && isBox(pinned) === true ? pinned : undefined;
  const step =
    active?.kind === "replay"
      ? numericState(state["step"], { fallback: 1, min: 1, max: active.steps, integer: true })
      : 0;
  return {
    pin,
    active,
    step,
    preview,
    state: {
      pin: pin ?? null,
      case: active?.id ?? null,
      step: active?.kind === "replay" ? step : null,
    },
    togglePin: (box) => update({ pin: pin === box ? null : box, case: null, step: null }),
    release: () => update({ pin: null }),
    toggleCase: (caseId) =>
      update(
        active?.id === caseId
          ? { case: null, step: null }
          : {
              case: caseId,
              pin: null,
              step: cases.find((item) => item.id === caseId)?.kind === "replay" ? "1" : null,
            },
      ),
    goToStep: (next) => update({ step: String(next) }),
    setPreview,
  };
}

/** A small pressable pill: case pickers, entry points and the boxes listed in the panel. */
export function Chip({
  pressed,
  onClick,
  children,
  note,
}: {
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly note?: string;
}): ReactNode {
  return (
    <button type="button" className="tack-chip" aria-pressed={pressed} onClick={onClick}>
      {children}
      {note === undefined ? null : <small>{note}</small>}
    </button>
  );
}

/** One chip per replay and lens, and Previous, Next and "Step n of m" while a replay runs. */
export function CaseControls({
  cases,
  view,
}: {
  readonly cases: readonly FrameCase[];
  readonly view: FigureView;
}): ReactNode {
  const groups = [
    { kind: "replay" as const, title: "Replay" },
    { kind: "lens" as const, title: "Lens" },
  ].flatMap((group) => {
    const members = cases.filter((item) => item.kind === group.kind);
    return members.length === 0 ? [] : [{ ...group, members }];
  });
  if (groups.length === 0) return null;
  const active = view.active;
  return (
    <>
      {groups.map((group) => (
        <div
          key={group.kind}
          className="tack-figure-cases"
          role="group"
          aria-label={`${group.title}s`}
        >
          <span className="tack-figure-key">{group.title}</span>
          {group.members.map((item) => (
            <Chip
              key={item.id}
              pressed={active?.id === item.id}
              onClick={() => view.toggleCase(item.id)}
            >
              {item.label}
            </Chip>
          ))}
        </div>
      ))}
      {active?.kind === "replay" ? (
        <div className="tack-figure-steps" role="group" aria-label="Replay steps">
          <output aria-live="polite" className="tack-figure-count">
            Step {view.step} of {active.steps}
          </output>
          <button
            type="button"
            className="tack-chip"
            disabled={view.step <= 1}
            onClick={() => view.goToStep(view.step - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="tack-chip"
            disabled={view.step >= active.steps}
            onClick={() => view.goToStep(view.step + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}

/** The issues of a figure, under it, in the same lines the figure check prints. */
function IssueList({ issues }: { readonly issues: readonly FigureIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <div className="tack-figure-issues" role="note" aria-label="Figure issues">
      <strong>
        {issues.length} {issues.length === 1 ? "issue" : "issues"}
      </strong>
      <ul>
        {issues.map((issue, index) => (
          <li key={index}>{issueLine(issue)}</li>
        ))}
      </ul>
    </div>
  );
}

export type LegendItem = { readonly key: string; readonly label: string; readonly mark: ReactNode };

/** The legend, generated by the component from what its drawing uses. */
export function Legend({ items }: { readonly items: readonly LegendItem[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <ul className="tack-figure-legend" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key}>
          {item.mark}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export type FigureFrameProps = {
  readonly id: string;
  readonly kind: FigureKind;
  /** The claim. */
  readonly title: string;
  readonly summary?: string;
  readonly issues: readonly FigureIssue[];
  /** The text equivalent, for copy and search. */
  readonly readable: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly className?: string;
  /** Case pickers and step controls, above the drawing. */
  readonly controls?: ReactNode;
  /** The drawing on its ground, at column width or in the Expand overlay. */
  readonly drawing?: (mode: "column" | "expanded") => ReactNode;
  /** "How to read this" and the details of the focus. */
  readonly panel?: ReactNode;
  readonly legend?: ReactNode;
  /** Escape outside the overlay: releases the pin. */
  readonly onEscape?: () => void;
  /** A figure without a drawing (steps, quantities) puts its body here. */
  readonly children?: ReactNode;
};

/**
 * The frame every figure shares: caption, summary, controls, drawing, panel, legend, issues.
 * Expand opens the drawing as a Base UI modal dialog rendered inside the figure, so the figure's
 * styles still apply: focus stays in it, the page behind it is inert, and Escape or Close returns
 * focus to Expand. Escape on the figure itself releases the pin instead. In the Markdown pass the
 * figure is its readable text in a fenced block of its own, line breaks and indentation kept: a
 * page's Markdown twin and `llms-full.txt` carry what the figure says, not its drawing.
 */
export function FigureFrame(props: FigureFrameProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const figure = useRef<HTMLElement>(null);
  if (markdownPass() === true) return <pre>{props.readable}</pre>;
  const look = lookAttributes(props.kind);
  const caption = (
    <figcaption className="tack-figure-caption">
      <span className="tack-figure-claim">{props.title}</span>
    </figcaption>
  );
  const summary =
    props.summary === undefined ? null : <p className="tack-figure-summary">{props.summary}</p>;
  const controls = (
    <div className="tack-figure-controls">
      {props.controls}
      {props.drawing === undefined ? null : (
        <Dialog.Trigger className="tack-chip tack-figure-expand">Expand</Dialog.Trigger>
      )}
    </div>
  );
  return (
    <Dialog.Root open={expanded} onOpenChange={setExpanded}>
      <figure
        ref={figure}
        id={props.id}
        className={`tack-figure${props.className === undefined ? "" : ` ${props.className}`}`}
        {...look}
        data-reader-readable={props.readable}
        data-reader-state={JSON.stringify(props.state)}
        data-figure-issues={JSON.stringify(props.issues.map(issueLine))}
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded === false) props.onEscape?.();
        }}
      >
        {caption}
        {summary}
        {props.controls === undefined && props.drawing === undefined ? null : controls}
        {props.drawing === undefined ? null : (
          <div className="tack-figure-ground">{props.drawing("column")}</div>
        )}
        {props.children}
        {props.panel}
        {props.legend}
        <IssueList issues={props.issues} />
        {props.drawing === undefined ? null : (
          <Dialog.Portal container={figure}>
            <Dialog.Popup
              className="tack-figure-overlay"
              aria-label={props.title}
              aria-modal="true"
            >
              <div className="tack-figure-overlay-head">
                {caption}
                <Dialog.Close className="tack-chip">Close</Dialog.Close>
              </div>
              <div className="tack-figure-controls">{props.controls}</div>
              <div className="tack-figure-overlay-body">
                <div className="tack-figure-ground">{props.drawing("expanded")}</div>
                {props.panel}
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </figure>
    </Dialog.Root>
  );
}
