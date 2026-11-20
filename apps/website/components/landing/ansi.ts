/** The colors the demo terminal draws; Tack paints only these. */
const colors = { 31: "red", 32: "green", 33: "yellow", 34: "blue", 36: "cyan" } as const;

type Color = (typeof colors)[keyof typeof colors];

/** A run of text with one style. */
export type AnsiSpan = {
  readonly text: string;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly color?: Color;
};

type Pen = Omit<AnsiSpan, "text">;

const plainPen: Pen = { bold: false, dim: false };

/** One SGR sequence, `ESC[...m`, capturing its parameters. */
const sgr = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`);

const isColorCode = (code: number): code is keyof typeof colors => code in colors;

/** Applies one SGR parameter to the pen; codes the terminal does not draw leave it unchanged. */
const applyCode = (pen: Pen, code: number): Pen => {
  if (code === 0) return plainPen;
  if (code === 1) return { ...pen, bold: true };
  if (code === 2) return { ...pen, dim: true };
  if (code === 22) return { ...pen, bold: false, dim: false };
  if (code === 39) return { bold: pen.bold, dim: pen.dim };
  return isColorCode(code) ? { ...pen, color: colors[code] } : pen;
};

/**
 * Splits terminal text into styled spans from its SGR escape sequences (`ESC[...m`). An empty
 * parameter list resets, as in a terminal; empty runs are dropped.
 */
export const parseAnsi = (text: string): ReadonlyArray<AnsiSpan> => {
  const pieces = text.split(sgr);
  return pieces.reduce<{ pen: Pen; spans: ReadonlyArray<AnsiSpan> }>(
    (state, piece, index) =>
      index % 2 === 1
        ? {
            ...state,
            pen: piece
              .split(";")
              .map((code) => (code === "" ? 0 : Number(code)))
              .reduce(applyCode, state.pen),
          }
        : piece === ""
          ? state
          : { ...state, spans: [...state.spans, { text: piece, ...state.pen }] },
    { pen: plainPen, spans: [] },
  ).spans;
};
