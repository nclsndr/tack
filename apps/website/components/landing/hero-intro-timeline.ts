/**
 * The hero's intro, in seconds from the first paint after the page hydrates. The headline is the
 * lead: its words rise out of their line one after another, and the lead paragraph and the buttons
 * follow. The demo window and the drafting lamp fade in below, lying back on the blueprint, and
 * wait for the visitor to scroll.
 */
export const heroIntro = {
  /** The blueprint sheet fades in under everything. */
  sheet: { delay: 0, duration: 1.4 },
  /** How long one word takes to rise out of its line. */
  wordDuration: 0.9,
  /** The gap between the first two words; each later gap is `wordGapDecay` times the one before. */
  wordGap: 0.1,
  wordGapDecay: 0.8,
  lead: { delay: 0.34, duration: 0.8 },
  actions: { delay: 0.42, duration: 0.8 },
  /** The window fades in lying back, while the headline's last words still rise. */
  window: { delay: 0.4, duration: 0.9 },
  lamp: { delay: 0.6, duration: 1.4 },
  /** A light runs once along the window's top edge when it lands. */
  edge: { duration: 1.2 },
} as const;

/**
 * When the word at `index` in the headline starts rising. The gaps shrink, so the headline reads as
 * one wave instead of a metronome, and a long headline still finishes within its budget.
 */
export const wordDelay = (index: number) =>
  (heroIntro.wordGap * (1 - heroIntro.wordGapDecay ** index)) / (1 - heroIntro.wordGapDecay);

/**
 * The hero as the page scrolls, as ranges of the pin: the hero holds the screen for a stretch of
 * scroll, from 0 when the page starts moving to 1 when the hero lets go. Over the whole stretch the
 * copy rises toward the top while the window rises to meet it, grows to full size and comes
 * upright on its top edge. The lamp brightens with it, its light catches the window's top edge
 * near the end, and drafting marks close in on the corners as it lands. Each part follows the
 * scroll one to one, so it never runs ahead of the visitor's hand.
 */
export const heroScroll = {
  /** The window counts as landed, and the walkthrough starts. */
  landed: 0.98,
  window: [0, 1],
  lamp: [0, 1],
  rim: [0.6, 1],
  marks: [0.75, 1],
} as const;

/** Whether the window has landed at `progress` through the pin. */
export const hasLanded = (progress: number) => progress >= heroScroll.landed;

/** What the pin measures of the page, in CSS pixels, with the hero laid out at rest. */
export type PinLayout = {
  /** The height of the screen the hero holds. */
  readonly viewport: number;
  /** The header's height: the page opens with it over the top of the hero. */
  readonly header: number;
  readonly copyTop: number;
  readonly copyHeight: number;
  readonly windowTop: number;
  readonly windowHeight: number;
  /** How far the page scrolls while the hero holds. */
  readonly travel: number;
};

/** How much of the window the first screen shows, as a share of it, between two bounds. */
const peekOf = (viewport: number) => Math.min(150, Math.max(88, viewport * 0.14));

/** The least room between the header and the copy when the copy is too tall to centre. */
const minimumGap = 16;

/**
 * Where the hero starts as the page opens, from its layout at rest. At rest the copy and the
 * window sit at the top with an equal gap above and between them. The page opens with the copy
 * centred between the header and a strip of the window, so the gap above the copy equals the gap
 * below it, and the window lies that strip from the bottom.
 *
 * `window` is how far the window starts below its place; it closes linearly over the pin. `copy`
 * gives how far the copy sits below its place at the start and when the header has scrolled away,
 * at `headerGone` through the pin; between those points it moves linearly too. The room above the
 * copy runs to the header's bottom edge while the header shows and to the top of the screen after,
 * and with those three points it equals the room below the copy at every point of the pin.
 * `overflow` is how far the window at rest reaches below the screen, the room the page must leave
 * after the hero.
 */
export const pinStart = (layout: PinLayout) => {
  const gap = layout.windowTop - layout.copyTop - layout.copyHeight;
  const room = layout.viewport - layout.header - peekOf(layout.viewport) - layout.copyHeight;
  const copyStart = layout.header + Math.max(minimumGap, room / 2);
  const windowStart = Math.max(
    layout.viewport - peekOf(layout.viewport),
    copyStart + layout.copyHeight + gap,
  );
  const window = windowStart - layout.windowTop;
  const copy = copyStart - layout.copyTop;
  const headerGone = Math.min(1, layout.header / layout.travel);
  const windowThen = layout.windowTop + window * (1 - headerGone);
  const copyThen = (windowThen - layout.copyHeight) / 2 - layout.copyTop;
  return {
    copy: [copy, Math.min(copy, Math.max(0, copyThen))] as const,
    headerGone,
    window,
    overflow: Math.max(0, layout.windowTop + layout.windowHeight - layout.viewport),
  };
};
