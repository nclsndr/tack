/**
 * The reader's token classes that a source may use in its own components and MDX. The reader's
 * stylesheet generates exactly these, whether or not the reader itself uses them; a test keeps
 * `reader.css` equal to this list, and the figure skill documents it.
 */

/** The reader's colour tokens, as Tailwind names. */
const tokenColors = [
  "paper",
  "sheet",
  "rule",
  "rule-strong",
  "ink",
  "body",
  "muted",
  "faint",
  "pen",
  "pen-wash",
  "red",
  "red-wash",
] as const;

/** What a colour can paint: HTML backgrounds, text and borders, SVG fills and strokes. */
const tokenProperties = ["bg", "text", "border", "fill", "stroke"] as const;

/** The grounds a source can put under its own drawing. */
export const groundClasses = [
  "tack-ground-quad-ruled",
  "tack-ground-ruled-lines",
  "tack-ground-dot-grid",
] as const;

/** The six quiet tints for raw SVG in an authored figure, with the classes that paint them. */
export const tintClasses = [
  "tack-tint-1",
  "tack-tint-2",
  "tack-tint-3",
  "tack-tint-4",
  "tack-tint-5",
  "tack-tint-6",
  "tack-tint-fill",
  "tack-tint-edge",
] as const;

/** The Tailwind utilities the reader generates for sources. */
export const tokenUtilities: readonly string[] = [
  ...tokenProperties.flatMap((property) => tokenColors.map((color) => `${property}-${color}`)),
  "font-mono",
  "font-sans",
];

/** Every published token class. */
export const tokenClasses: readonly string[] = [
  ...tokenUtilities,
  ...groundClasses,
  ...tintClasses,
];
