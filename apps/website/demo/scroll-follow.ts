/** Where a scrolling view stands: its offset, its visible height and its full height. */
type ScrollBox = {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
};

/** How far from the end still counts as the bottom, so a sub-pixel offset does not stop following. */
const slack = 24;

/** Whether the view shows its last row. */
export const atBottom = (box: ScrollBox) =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= slack;

/**
 * Whether a log keeps its newest message in view, and how many messages arrived that a reader who
 * scrolled up has not seen yet.
 */
export type Follow = { readonly follow: boolean; readonly unseen: number };

/**
 * What changes it: the reader scrolled, messages were `added`, the reader jumped to the end, or the
 * log started over.
 */
export type FollowEvent =
  | { readonly kind: "scrolled"; readonly atBottom: boolean }
  | { readonly kind: "grew"; readonly added: number }
  | { readonly kind: "jumped" }
  | { readonly kind: "cleared" };

/** A log at rest: it follows its newest message, with nothing unseen. */
export const following: Follow = { follow: true, unseen: 0 };

/**
 * The follow state after `event`. A reader who scrolls up stops the following, and messages that
 * arrive then count as unseen until the reader is back at the bottom.
 */
export const followAfter = (state: Follow, event: FollowEvent): Follow => {
  if (event.kind === "grew")
    return state.follow === true ? state : { ...state, unseen: state.unseen + event.added };
  if (event.kind === "scrolled" && event.atBottom === false) return { ...state, follow: false };
  return following;
};

/** The hint over the input box, as a coding agent's terminal words it. */
export const unseenLabel = (count: number) =>
  `${count} new ${count === 1 ? "message" : "messages"} (click) ↓`;
