/**
 * The panel under a drawing, shared by every figure that has one: on the left "How to read this"
 * with the reading rule and the entry points, on the right the active case, the pinned part, or a
 * hint. Each figure supplies the details of its own pinned part.
 */
import type { ReactNode } from "react";
import { Chip, type FigureView } from "./frame.tsx";

/** The left half: the reading rule and the entry points. */
export function ReadingPanel({
  rule,
  startWith,
  view,
}: {
  readonly rule: { readonly title: string; readonly text: string } | undefined;
  readonly startWith: readonly { readonly id: string; readonly label: string }[];
  readonly view: FigureView;
}): ReactNode {
  // Nothing to say: keep the column, so the details stay on the right.
  if (rule === undefined && startWith.length === 0) return <section />;
  return (
    <section>
      <h4 className="tack-figure-key">How to read this</h4>
      {rule === undefined ? null : (
        <p>
          <strong>{rule.title}.</strong> {rule.text}
        </p>
      )}
      {startWith.length === 0 ? null : (
        <>
          <span className="tack-figure-key">Start with</span>
          <span className="tack-chips">
            {startWith.map((entry) => (
              <Chip
                key={entry.id}
                pressed={view.pin === entry.id}
                onClick={() => view.togglePin(entry.id)}
              >
                {entry.label}
              </Chip>
            ))}
          </span>
        </>
      )}
    </section>
  );
}

/** A case as the panel shows it: a replay's steps or a lens's note. */
export type PanelCase =
  | {
      readonly kind: "replay";
      readonly label: string;
      readonly steps: readonly { readonly at: string; readonly note: string }[];
    }
  | { readonly kind: "lens"; readonly label: string; readonly note: string };

/** The right half: the active case, else the pinned part, else a hint. */
export function DetailPanel({
  active,
  view,
  labelOf,
  pinned,
  hint,
}: {
  readonly active: PanelCase | undefined;
  readonly view: FigureView;
  readonly labelOf: (id: string) => string;
  /** The details of the pinned part, when one is pinned. */
  readonly pinned: ReactNode;
  readonly hint: string;
}): ReactNode {
  if (active?.kind === "replay") {
    const step = active.steps[view.step - 1];
    return (
      <section aria-live="polite">
        <h4 className="tack-figure-key">
          {active.label}, step {view.step} of {active.steps.length}
        </h4>
        {step === undefined ? null : (
          <>
            <p className="tack-figure-who">
              <strong>{labelOf(step.at)}</strong>
            </p>
            <p>{step.note}</p>
          </>
        )}
      </section>
    );
  }
  if (active?.kind === "lens")
    return (
      <section aria-live="polite">
        <h4 className="tack-figure-key">{active.label}</h4>
        <p>{active.note}</p>
      </section>
    );
  return (
    <section aria-live="polite">{pinned ?? <p className="tack-figure-hint">{hint}</p>}</section>
  );
}

/** A titled row of chips that move the pin: "Uses", "Used by", "Points at". */
export function PinChips({
  title,
  entries,
  view,
}: {
  readonly title: string;
  readonly entries: readonly {
    readonly id: string;
    readonly label: string;
    readonly note?: string;
  }[];
  readonly view: FigureView;
}): ReactNode {
  return (
    <div>
      <span className="tack-figure-key">
        {title} {entries.length}
      </span>
      <span className="tack-chips">
        {entries.map((entry) => (
          <Chip
            key={entry.id}
            onClick={() => view.togglePin(entry.id)}
            {...(entry.note === undefined ? {} : { note: entry.note })}
          >
            {entry.label}
          </Chip>
        ))}
      </span>
    </div>
  );
}

/** A one-line description of the current view, appended to the text equivalent. */
export function viewLine(
  active:
    | { readonly kind: "replay" | "lens"; readonly label: string; readonly steps?: number }
    | undefined,
  view: FigureView,
  labelOf: (id: string) => string,
): string {
  if (active?.kind === "replay")
    return `View: replay ${active.label}, step ${view.step} of ${active.steps ?? 0}`;
  if (active?.kind === "lens") return `View: lens ${active.label}`;
  return view.pin === undefined ? "" : `View: pinned ${labelOf(view.pin)}`;
}
