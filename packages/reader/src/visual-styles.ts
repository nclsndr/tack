/** Class lists shared by the visual kit's numbered plates. */
export const visualStyles = {
  figure:
    "tack-visual overflow-hidden rounded-sm border border-rule-strong bg-sheet font-sans text-sm leading-normal text-body [counter-increment:tack-figure]",
  caption:
    "flex items-baseline gap-2.5 border-b border-rule px-4.5 pt-3.5 pb-3 text-base leading-snug font-semibold text-ink before:shrink-0 before:font-mono before:text-xs before:leading-none before:font-medium before:tracking-wide before:text-print before:content-['Fig._'_counter(tack-figure)]",
  toolbar:
    "flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-rule px-4.5 py-2.5 text-sm",
  footer:
    "flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-rule px-4.5 py-2.5 text-sm",
  label: "inline-flex items-center gap-2 text-muted",
  output: "font-mono text-xs leading-none text-muted tabular-nums",
  readout: "border-t border-rule px-4.5 pt-3 pb-3.5 text-sm text-body",
  canvas: "bg-quad-ruled",
  edgeLabel:
    "fill-muted stroke-paper stroke-5 font-sans text-xs [paint-order:stroke] [stroke-linejoin:round]",
  nodeFocus: "group-focus-visible/node:stroke-pen group-focus-visible/node:stroke-3",
  stepTab:
    "min-h-10 -mb-px rounded-none border-0 border-b-2 border-transparent bg-transparent px-2.5 py-2 whitespace-nowrap text-muted hover:text-ink aria-[current=step]:border-pen aria-[current=step]:font-semibold aria-[current=step]:text-ink",
  stepNumber: "font-mono text-xs leading-none font-normal text-faint tabular-nums",
} as const;
