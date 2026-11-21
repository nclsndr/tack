import {
  animate,
  motion,
  scroll,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionStyle,
  type MotionValue,
  type Transition,
} from "motion/react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { hasLanded, heroIntro, heroScroll, pinStart, wordDelay } from "./hero-intro-timeline.ts";

/** The brand's `--tack-ease`: a strong ease-out, so each part arrives fast and settles slowly. */
const ease = [0.16, 1, 0.3, 1] as const;

/**
 * A transition for one part of the intro. Under reduced motion every part is already at rest: the
 * stylesheet pins the end state, and this skips the timing too.
 */
function useIntroTransition(transition: Transition): Transition {
  return useReducedMotion() === true ? { duration: 0, delay: 0 } : transition;
}

/**
 * The scroll-linked style of one part, or none under reduced motion, so no scroll animation runs
 * at all; the stylesheet already holds the part at rest.
 */
function useScrollStyle(style: MotionStyle): MotionStyle {
  return useReducedMotion() === true ? {} : style;
}

/**
 * What the page shows without the intro: under reduced motion, and without JavaScript, every part
 * that the intro or the scroll moves is drawn at rest. Each part marks itself with `data-intro`,
 * and each one-off accent with `data-intro-accent`.
 */
const atRest = [
  "[data-intro]{opacity:1!important;transform:none!important}",
  "[data-intro-accent]{display:none!important}",
  ".hero-track{height:auto!important;margin-bottom:0!important}",
  ".hero-pin{position:relative!important;height:auto!important}",
].join("");

/** Draws the hero at rest when the browser runs no JavaScript, so nothing waits for the intro. */
export function IntroFallback() {
  return (
    <noscript>
      <style>{atRest}</style>
    </noscript>
  );
}

/**
 * The pinned hero: the scroll track, the copy, the layer behind it and the window's stage, the
 * copy's box at rest, and how far the pin has run as the page scrolls, from 0 to 1.
 */
const HeroPinContext = createContext<{
  readonly track: RefObject<HTMLDivElement | null>;
  readonly copy: RefObject<HTMLDivElement | null>;
  readonly stage: RefObject<HTMLDivElement | null>;
  readonly progress: MotionValue<number>;
  readonly field: RefObject<HTMLDivElement | null>;
  readonly copyBox: HeroCopyBox | undefined;
} | null>(null);

/** The copy's box at rest inside the pin, in pixels, and the pin's width. */
export type HeroCopyBox = { readonly top: number; readonly height: number; readonly width: number };

function useHeroPin() {
  const value = useContext(HeroPinContext);
  // Coverage skip: every part of the hero renders inside `HeroPin`.
  /* v8 ignore next -- @preserve */
  if (value === null) throw new Error("A hero part rendered outside HeroPin.");
  return value;
}

/**
 * The layer behind the copy: the element that rides with the copy as the hero pins, and the
 * copy's box at rest once measured.
 */
export function useHeroField() {
  const { field, copyBox } = useHeroPin();
  return { field, copyBox };
}

/** Where `element`'s layout box sits inside `ancestor`, leaving out any transform on the way. */
const layoutOffset = (element: HTMLElement, ancestor: HTMLElement) => {
  let top = 0;
  let left = 0;
  let node: HTMLElement | null = element;
  while (node !== null && node !== ancestor) {
    top += node.offsetTop;
    left += node.offsetLeft;
    const parent: Element | null = node.offsetParent;
    node = parent instanceof HTMLElement ? parent : null;
  }
  return { top, left };
};

/** The pin's whole run, from the page's first move to the hero letting go. */
const pinRun = { offset: ["start start", "end end"] } as const;

/** How far below its place a part sits at points of the pin's run, the last one at its place. */
type Rise = { readonly below: ReadonlyArray<number>; readonly times: ReadonlyArray<number> };

/**
 * Raises `element` to its place over the pin's run, through the points `rise` gives. The animation
 * runs on the track's native view timeline, so it moves on the compositor; it is built again when
 * the layout changes the distances.
 */
function useRise(
  element: RefObject<HTMLElement | null>,
  track: RefObject<HTMLElement | null>,
  rise: Rise | undefined,
) {
  const key = rise === undefined ? "" : `${rise.below.join(",")}@${rise.times.join(",")}`;
  useLayoutEffect(() => {
    const target = element.current;
    const timeline = track.current;
    if (target === null || timeline === null || rise === undefined) return undefined;
    const steps = rise.below.map((distance) => `translateY(${distance}px)`);
    target.style.transform = steps[0] ?? "";
    const animation = animate(
      target,
      { transform: steps },
      { duration: 1, ease: "linear", times: [...rise.times] },
    );
    const stop = scroll(animation, { target: timeline, offset: [...pinRun.offset] });
    return () => {
      stop();
      animation.stop();
      target.style.transform = "";
    };
    // The key stands for `rise`, which is a new object on every render.
  }, [element, track, key]);
}

/**
 * Holds the hero on screen for a stretch of scroll. While it holds, the copy rises toward the top
 * and the window rises to meet it, so the room above the copy and the room below it shrink
 * together; when the window is in place, the hero lets go and the page scrolls on. The distances
 * come from the layout at rest, measured again when it changes. Under reduced motion the hero
 * does not hold: the stylesheet lays it out at rest.
 */
export function HeroPin({ children }: { readonly children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const still = useReducedMotion() === true;
  const { scrollYProgress } = useScroll({ target: track, offset: [...pinRun.offset] });
  const [start, setStart] = useState<ReturnType<typeof pinStart>>();
  const [copyBox, setCopyBox] = useState<HeroCopyBox>();

  useLayoutEffect(() => {
    const box = pin.current;
    const copied = copy.current;
    const staged = stage.current;
    const holder = track.current;
    if (box === null || copied === null || staged === null || holder === null) return undefined;
    const measure = () => {
      // The layer behind the copy needs the copy's box under reduced motion too.
      const resting = {
        top: layoutOffset(copied, box).top,
        height: copied.offsetHeight,
        width: box.clientWidth,
      };
      setCopyBox((previous) =>
        previous !== undefined &&
        previous.top === resting.top &&
        previous.height === resting.height &&
        previous.width === resting.width
          ? previous
          : resting,
      );
      if (still === true) {
        setStart(undefined);
        return;
      }
      const header = document.querySelector(".landing-header")?.getBoundingClientRect().height;
      const next = pinStart({
        viewport: box.clientHeight,
        header: header ?? 0,
        copyTop: resting.top,
        copyHeight: resting.height,
        windowTop: layoutOffset(staged, box).top,
        windowHeight: staged.offsetHeight,
      });
      holder.style.setProperty("--hero-overflow", `${next.overflow}px`);
      // `useRise` rebuilds only when the distances change, so a new object here costs nothing.
      setStart(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(copied);
    observer.observe(staged);
    return () => observer.disconnect();
  }, [still]);

  const copyRise = start === undefined ? undefined : { below: [start.copy, 0], times: [0, 1] };
  useRise(copy, track, copyRise);
  // The layer behind the copy rides with it, so the copy always sits on the same part of it.
  useRise(field, track, copyRise);
  useRise(
    stage,
    track,
    start === undefined ? undefined : { below: [start.window, 0], times: [0, 1] },
  );

  const value = useMemo(
    () => ({ track, copy, stage, progress: scrollYProgress, field, copyBox }),
    [scrollYProgress, copyBox],
  );
  return (
    <HeroPinContext.Provider value={value}>
      <div ref={track} className="hero-track">
        <div ref={pin} className="hero-pin">
          {children}
        </div>
      </div>
    </HeroPinContext.Provider>
  );
}

/** `value` modulo `size`, always positive. */
const wrap = (value: number, size: number) => ((value % size) + size) % size;

/**
 * The blueprint sheet under the hero: a drafting grid that fades in first and holds still while
 * the hero pins. Its lines are laid from the window's top left corner at rest, so the window
 * sits on the grid once it is in place.
 */
export function HeroSheet() {
  const { stage } = useHeroPin();
  const sheet = useRef<HTMLDivElement>(null);
  const transition = useIntroTransition({ ...heroIntro.sheet, ease: "linear" });
  useEffect(() => {
    const element = sheet.current;
    const anchor = stage.current;
    const parent = element?.offsetParent;
    if (element === null || anchor === null || !(parent instanceof HTMLElement)) return undefined;
    const align = () => {
      const at = layoutOffset(anchor, parent);
      const grid = (size: number) => `${wrap(at.left, size)}px ${wrap(at.top, size)}px`;
      element.style.backgroundPosition = [grid(120), grid(120), grid(24), grid(24)].join(", ");
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(element);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [stage]);
  return (
    <motion.div
      ref={sheet}
      className="hero-sheet"
      aria-hidden="true"
      data-intro=""
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={transition}
    />
  );
}

/**
 * The headline, one line per sentence, with each word rising out of its line. Screen readers get
 * the headline whole, from the label.
 */
export function HeroHeadline({ id, text }: { readonly id: string; readonly text: string }) {
  const lines = text.split(/(?<=\.) /);
  let next = 0;
  const words = lines.map((line) => line.split(" ").map((word) => ({ word, index: next++ })));
  return (
    <h1 id={id} aria-label={text}>
      {words.map((line, row) => (
        <span key={row} className="landing-hero-line" aria-hidden="true">
          {line.map(({ word, index }) => (
            <HeadlineWord key={index} word={word} index={index} />
          ))}
        </span>
      ))}
    </h1>
  );
}

/** One word of the headline, in a mask it rises out of. */
function HeadlineWord({ word, index }: { readonly word: string; readonly index: number }) {
  const transition = useIntroTransition({
    delay: wordDelay(index),
    duration: heroIntro.wordDuration,
    ease,
  });
  return (
    <>
      <span className="hero-word">
        <motion.span
          className="hero-word-ink"
          data-intro=""
          initial={{ transform: "translateY(108%)" }}
          animate={{ transform: "translateY(0%)" }}
          transition={transition}
        >
          {word}
        </motion.span>
      </span>{" "}
    </>
  );
}

/** A part that follows the headline: it fades in and rises a short way into place. */
export function HeroFollow({
  part,
  className,
  children,
}: {
  readonly part: "lead" | "actions";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const transition = useIntroTransition({ ...heroIntro[part], ease });
  return (
    <motion.div
      className={className}
      data-intro=""
      initial={{ opacity: 0, transform: "translateY(14px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}

/**
 * The copy band. At rest it sits at the top of the hero; the page opens with it centred in the
 * first screen, and it rises to its place as the hero pins.
 */
export function HeroCopy({ children }: { readonly children: ReactNode }) {
  const { copy } = useHeroPin();
  return (
    <div ref={copy} className="hero-copy">
      {children}
    </div>
  );
}

/**
 * The window a little smaller and leaning back on its top edge, and at full size upright in place.
 * It hinges on the top edge, the part in view when the page opens.
 */
const pose = {
  lying: "rotateX(24deg) scale(0.88)",
  upright: "rotateX(0deg) scale(1)",
} as const;

/** One drafting mark at a corner of the window, closing in as the window comes upright. */
function CornerMark({
  corner,
  progress,
}: {
  readonly corner: (typeof corners)[number];
  readonly progress: MotionValue<number>;
}) {
  const transform = useTransform(
    progress,
    [...heroScroll.marks],
    [`translate(${corner.x}px, ${corner.y}px)`, "translate(0px, 0px)"],
  );
  const opacity = useTransform(progress, [...heroScroll.marks], [0, 1]);
  const style = useScrollStyle({ transform, opacity });
  return (
    <motion.span
      className="hero-mark"
      aria-hidden="true"
      data-corner={corner.name}
      data-intro=""
      style={style}
    />
  );
}

/** The window's four corners, each with the direction its mark closes in from. */
const corners = [
  { name: "top-left", x: -12, y: -12 },
  { name: "top-right", x: 12, y: -12 },
  { name: "bottom-left", x: -12, y: 12 },
  { name: "bottom-right", x: 12, y: 12 },
] as const;

/**
 * The demo window's entrance. It fades in smaller and leaning back on the blueprint, with a strip
 * of it in view, then rises under the copy, grows to full size and comes upright as the hero pins,
 * under a drafting lamp that brightens. When it lands, a light runs once along its top edge and
 * `onLanded` runs.
 */
export function WindowEntrance({
  onLanded,
  children,
}: {
  readonly onLanded: () => void;
  readonly children: ReactNode;
}) {
  const { stage, progress } = useHeroPin();
  const standing = useTransform(progress, [...heroScroll.window], [pose.lying, pose.upright]);
  const lampLevel = useTransform(progress, [...heroScroll.lamp], [0.45, 1]);
  const rimLevel = useTransform(progress, [...heroScroll.rim], [0, 1]);
  const standingStyle = useScrollStyle({ transform: standing });
  const lampStyle = useScrollStyle({ opacity: lampLevel });
  const rimStyle = useScrollStyle({ opacity: rimLevel });

  const [landed, setLanded] = useState(false);
  useMotionValueEvent(progress, "change", (value) => {
    if (hasLanded(value) === true) setLanded(true);
  });
  useEffect(() => {
    if (landed === true) onLanded();
  }, [landed, onLanded]);

  const fadeIn = useIntroTransition({ ...heroIntro.window, ease });
  const lampIn = useIntroTransition({ ...heroIntro.lamp, ease });
  const edge = useIntroTransition({
    duration: heroIntro.edge.duration,
    ease: "easeInOut",
    times: [0, 0.2, 0.75, 1],
  });

  return (
    <div ref={stage} className="hero-stage">
      <motion.div className="hero-lamp" aria-hidden="true" data-intro="" style={lampStyle}>
        <motion.span
          className="hero-lamp-light"
          data-intro=""
          initial={{ opacity: 0, transform: "scale(0.86)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          transition={lampIn}
        />
      </motion.div>
      <motion.div className="hero-window" data-intro="" style={standingStyle}>
        <motion.div
          data-intro=""
          initial={{ opacity: 0, transform: "translateY(24px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          transition={fadeIn}
        >
          {children}
        </motion.div>
        <motion.span
          className="hero-window-rim"
          aria-hidden="true"
          data-intro=""
          style={rimStyle}
        />
        <span className="hero-window-edge" aria-hidden="true" data-intro-accent="">
          <motion.span
            variants={{
              waiting: { opacity: 0, transform: "translateX(-100%)" },
              landed: {
                opacity: [0, 1, 1, 0],
                transform: [
                  "translateX(-100%)",
                  "translateX(40%)",
                  "translateX(220%)",
                  "translateX(300%)",
                ],
              },
            }}
            initial="waiting"
            animate={landed === true ? "landed" : "waiting"}
            transition={edge}
          />
        </span>
      </motion.div>
      {corners.map((corner) => (
        <CornerMark key={corner.name} corner={corner} progress={progress} />
      ))}
    </div>
  );
}
