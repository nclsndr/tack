/**
 * Input and layout issues, and the lenient readers that turn an author's props into a figure's
 * data. A figure never throws on bad input: it keeps what it can read and reports the rest. The
 * in-page issue list and the figure check print the same lines, because both call `issueLine`.
 */

/** A defect in what the author wrote (`input`), or one only the layout can show (`layout`). */
export type FigureIssue = { readonly kind: "input" | "layout"; readonly message: string };

/** The one text form of an issue, shared by the page and the figure check. */
export function issueLine(issue: FigureIssue): string {
  return `${issue.kind}: ${issue.message}`;
}

export const inputIssue = (message: string): FigureIssue => ({ kind: "input", message });
export const layoutIssue = (message: string): FigureIssue => ({ kind: "layout", message });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && Array.isArray(value) === false;

/** A plain object, or `undefined` for anything else. */
export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) === true ? value : undefined;
}

/** A non-empty trimmed string, or `undefined`. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The items of an array, or none. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) === true ? (value as readonly unknown[]) : [];
}

/** The fewest words a claim can have. "CLI architecture" is a topic, not a claim. */
export const minimumClaimWords = 4;

/** A figure's `id` must be a short lowercase slug, unique on the page. */
export function idIssues(id: unknown): readonly FigureIssue[] {
  const value = text(id);
  if (value === undefined) return [inputIssue("id is required: a short lowercase slug")];
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
    ? []
    : [inputIssue(`id "${value}" is not a short lowercase slug`)];
}

/** A figure's `title` is its claim: one sentence, never a topic label. */
export function claimIssues(title: unknown): readonly FigureIssue[] {
  const value = text(title);
  if (value === undefined)
    return [inputIssue("title is missing; write the claim the figure proves as a sentence")];
  return value.split(/\s+/).length < minimumClaimWords
    ? [
        inputIssue(
          `title "${value}" reads as a noun phrase; write the claim the figure proves as a sentence`,
        ),
      ]
    : [];
}
