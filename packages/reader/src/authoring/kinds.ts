/** The kinds of callout and the name each shows; the component gives each its icon. */
export const calloutLabels = {
  note: "Note",
  tip: "Tip",
  warning: "Warning",
  decision: "Decision",
} as const;

export type CalloutKind = keyof typeof calloutLabels;

/** The author components the component check knows. */
export const authorComponentNames = ["Callout", "Tabs", "Tab", "Term"] as const;

export type AuthorComponentName = (typeof authorComponentNames)[number];
