import { motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/** The brand's `--tack-ease`: a strong ease-out, so each part arrives fast and settles slowly. */
export const ease = [0.16, 1, 0.3, 1] as const;

/** `value` modulo `size`, always positive. */
const wrap = (value: number, size: number) => ((value % size) + size) % size;

/**
 * The blueprint sheet the hero sits on, carried on under the sections after it: the same drafting
 * grid, a major line every five minor ones, with its columns laid from the page's content edge, so
 * the hero's window, the story's plate and the feature sheets share one set of lines. It fades in
 * at its top, where the hero's sheet fades out, and out at its bottom.
 */
export function DraftingSheet({ children }: { readonly children: ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sheet.current;
    const edge = anchor.current;
    if (element === null || edge === null) return undefined;
    const align = () => {
      const left = edge.offsetLeft;
      const grid = (size: number) => `${wrap(left, size)}px 0px`;
      element.style.backgroundPosition = [grid(120), grid(120), grid(24), grid(24)].join(", ");
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="sheet-run">
      <div ref={sheet} className="sheet-grid" aria-hidden="true" />
      <div ref={anchor} className="landing-shell sheet-anchor" aria-hidden="true" />
      {children}
    </div>
  );
}

/** The four corners of a frame, each with the direction its mark closes in from. */
export const corners = [
  { name: "top-left", x: -12, y: -12 },
  { name: "top-right", x: 12, y: -12 },
  { name: "bottom-left", x: -12, y: 12 },
  { name: "bottom-right", x: 12, y: 12 },
] as const;

/**
 * A part that settles in as its frame scrolls into view: it waits a short way down and faint, and
 * rises into place when the frame's `here` variant runs.
 */
export const settle = (delay: number, rise = 12): Variants => ({
  away: { opacity: 0, transform: `translateY(${rise}px)` },
  here: {
    opacity: 1,
    transform: "translateY(0px)",
    transition: { duration: 0.6, delay, ease },
  },
});

/**
 * A frame whose parts play their `here` variant once, when a share of it scrolls into view. Under
 * reduced motion, and before hydration without JavaScript, every part is drawn at rest.
 */
export function InView({
  as = "div",
  amount = 0.35,
  className,
  children,
}: {
  readonly as?: "div" | "article";
  readonly amount?: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const still = useReducedMotion() === true;
  const Frame = as === "article" ? motion.article : motion.div;
  return (
    <Frame
      className={className}
      initial={still ? "here" : "away"}
      whileInView="here"
      viewport={{ once: true, amount }}
    >
      {children}
    </Frame>
  );
}
