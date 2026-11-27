/** Collapses whitespace so multi-line text becomes one displayable line. */
export const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
