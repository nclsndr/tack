/**
 * One replacement in the text of a `tack.yaml`: the bytes from `start` up to `end` (exclusive)
 * become `text`. `start === end` inserts.
 */
export type DeclarationTextEdit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

/**
 * Applies one edit to the text of a `tack.yaml`, keeping every byte outside it. The file is never
 * re-serialized.
 *
 * Each top-level key Tack writes finds its own span. The imports section finds it by lines
 * (`features/imports/imports-section.ts`) and profiles find theirs through the `yaml` CST
 * (`domain/profiles/publication-text.ts`). The two cannot share a locator without changing the
 * bytes they write: the line locator leaves an indented comment after the last record outside the
 * span and refuses a quoted or flow key, while the CST locator takes that comment into the span,
 * accepts those keys, and appends with its own blank-line and line-ending rules.
 */
export const applyDeclarationTextEdit = (text: string, edit: DeclarationTextEdit): string =>
  `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
