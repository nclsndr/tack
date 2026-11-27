/**
 * Replays and lenses, the cases a figure can step through, read the same way by every figure that
 * has them: a label, a note, a step budget and a unique id. Each figure says how it reads a step
 * and what a lens holds besides its note, because the ids those name differ per figure.
 */
import { type FigureIssue, inputIssue, list, record, text } from "./issues.ts";

/** A replay walks its steps in order; a lens shows one state with its own extra fields. */
export type FigureCase<Step, Lens> =
  | {
      readonly kind: "replay";
      readonly id: string;
      readonly label: string;
      readonly steps: readonly Step[];
    }
  | ({
      readonly kind: "lens";
      readonly id: string;
      readonly label: string;
      readonly note: string;
    } & Lens);

/** The fields a lens reader may add: any but the ones every lens shares. */
type LensFields = Readonly<Record<string, unknown>> & {
  readonly kind?: never;
  readonly id?: never;
  readonly label?: never;
  readonly note?: never;
};

/** What a figure adds to the shared reading of its cases. */
type CaseReading<Step, Lens extends LensFields> = {
  /** The most steps a replay may have before it is reported. */
  readonly steps: number;
  /** Where every issue goes, in the order the author wrote the cases. */
  readonly issues: FigureIssue[];
  /** One step, or `undefined` to drop it; `where` names the step in an issue. */
  readonly step: (fields: Readonly<Record<string, unknown>>, where: string) => Step | undefined;
  /** The fields a lens holds besides its label and note; `name` names the lens in an issue. */
  readonly lens: (lens: Readonly<Record<string, unknown>>, name: string) => Lens;
};

/** A label as an id: lowercase words joined by `-`, empty when the label has no letter or digit. */
export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Reads `raw.replays`, then `raw.lenses`. A replay without a step that reads is dropped; every
 * lens is kept. An id is the authored one, or the label's slug, and a repeated id gets a suffix.
 */
export function readCases<Step, Lens extends LensFields>(
  raw: Readonly<Record<string, unknown>>,
  reading: CaseReading<Step, Lens>,
): readonly FigureCase<Step, Lens>[] {
  const { issues } = reading;
  const usedIds = new Set<string>();
  const caseId = (authored: string | undefined, label: string, fallback: string): string => {
    const base = authored ?? (slug(label) === "" ? fallback : slug(label));
    const id = usedIds.has(base) === true ? `${base}-${usedIds.size + 1}` : base;
    usedIds.add(id);
    return id;
  };
  const replays = list(raw["replays"]).flatMap((value, index): FigureCase<Step, Lens>[] => {
    const replay = record(value) ?? {};
    const label = text(replay["label"]);
    const name = label === undefined ? `replay ${index + 1}` : `replay "${label}"`;
    if (label === undefined) issues.push(inputIssue(`${name} has no label`));
    const authored = list(replay["steps"]);
    if (authored.length === 0) issues.push(inputIssue(`${name} has no steps`));
    if (authored.length > reading.steps)
      issues.push(
        inputIssue(`${name} has ${authored.length} steps; the budget is ${reading.steps}`),
      );
    const steps = authored.flatMap((entry, step) => {
      const read = reading.step(record(entry) ?? {}, `${name} step ${step + 1}`);
      return read === undefined ? [] : [read];
    });
    const shown = label ?? `Replay ${index + 1}`;
    return steps.length === 0
      ? []
      : [
          {
            kind: "replay",
            id: caseId(text(replay["id"]), shown, `replay-${index + 1}`),
            label: shown,
            steps,
          },
        ];
  });
  const lenses = list(raw["lenses"]).map((value, index): FigureCase<Step, Lens> => {
    const lens = record(value) ?? {};
    const label = text(lens["label"]);
    const note = text(lens["note"]);
    const name = label === undefined ? `lens ${index + 1}` : `lens "${label}"`;
    if (label === undefined) issues.push(inputIssue(`${name} has no label`));
    if (note === undefined) issues.push(inputIssue(`${name} has no note`));
    const extra = reading.lens(lens, name);
    const shown = label ?? `Lens ${index + 1}`;
    return {
      kind: "lens",
      id: caseId(text(lens["id"]), shown, `lens-${index + 1}`),
      label: shown,
      note: note ?? "",
      ...extra,
    };
  });
  return [...replays, ...lenses];
}
