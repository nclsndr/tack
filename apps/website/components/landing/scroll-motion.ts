import { animate, scroll, useReducedMotion } from "motion/react";
import { useEffect, useSyncExternalStore, type RefObject } from "react";

/** Where a scroll-linked animation starts and ends, as Motion's scroll offsets. */
export type ScrollRange = NonNullable<NonNullable<Parameters<typeof scroll>[1]>["offset"]>;

/** One part's keyframes over a scroll range: each property's values, at `times` of the range. */
export type ScrollFrames = {
  readonly opacity?: ReadonlyArray<number>;
  readonly transform?: ReadonlyArray<string>;
  readonly times?: ReadonlyArray<number>;
};

/**
 * Plays `frames` on `element` as `target` crosses `range` of the viewport. The animation is a Motion
 * animation attached to the target's native view timeline, so it runs on the compositor and
 * follows the scroll one to one. Under reduced motion nothing is attached and the element stays at
 * rest, as the stylesheet draws it; the same holds before hydration and without JavaScript.
 *
 * It attaches in a passive effect, not a layout effect: `target` is often an ancestor, and React
 * attaches an ancestor's ref only after its children's layout effects have run.
 */
export function useScrollFrames(
  element: RefObject<HTMLElement | null>,
  target: RefObject<HTMLElement | null>,
  frames: ScrollFrames,
  range: ScrollRange,
) {
  const still = useReducedMotion() === true;
  const key = JSON.stringify([frames, range]);
  useEffect(() => {
    const node = element.current;
    const timeline = target.current;
    if (still === true || node === null || timeline === null) return undefined;
    const keyframes = {
      ...(frames.opacity === undefined ? {} : { opacity: [...frames.opacity] }),
      ...(frames.transform === undefined ? {} : { transform: [...frames.transform] }),
    };
    const animation = animate(node, keyframes, {
      duration: 1,
      ease: "linear",
      ...(frames.times === undefined ? {} : { times: [...frames.times] }),
    });
    const stop = scroll(animation, { target: timeline, offset: [...range] });
    return () => {
      stop();
      animation.stop();
      node.style.removeProperty("opacity");
      node.style.removeProperty("transform");
    };
    // The key stands for `frames` and `range`, which are new objects on every render.
  }, [element, target, key, still]);
}

const wideQuery = "(min-width: 1024px)";

const subscribeWide = (change: () => void) => {
  const query = window.matchMedia(wideQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/**
 * Whether the page pins its scroll-driven moments: on a wide screen without reduced motion. The
 * stylesheet pins under the same conditions; the server and narrow screens do not pin.
 */
export function usePinned() {
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
  const still = useReducedMotion() === true;
  return wide && still === false;
}
