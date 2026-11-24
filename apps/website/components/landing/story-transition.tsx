import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useTransform,
  useMotionValueEvent,
} from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  defaultTransition,
  laneCount,
  layoutReins,
  reinPath,
  reinSpan,
  rulerTicks,
  tallyLinks,
  trackPoint,
  transitionFrom,
  type Transition,
} from "../../demo/story-transition.ts";
import { story } from "./content.ts";
import { useDemoLinks } from "./demo-links.tsx";
import { ease } from "./drafting-sheet.tsx";

const unsubscribe = () => undefined;
const subscribe = () => unsubscribe;

/**
 * The way the page carries the demo into the story, from `?transition=` in the address. The page
 * is built with the default, and a visitor's choice applies once it runs, which only swaps the
 * decoration: every layer it draws is out of the flow.
 */
export function useTransitionChoice(): Transition {
  return useSyncExternalStore(
    subscribe,
    () => transitionFrom(window.location.search),
    () => defaultTransition,
  );
}

/** The demo's links counted, how many commands made links, and how many commands ran. */
function useDemoBeat() {
  const state = useDemoLinks();
  return {
    ...tallyLinks(state?.field),
    changes: state?.changes ?? 0,
    commands: state?.commands ?? 0,
  };
}

/** The saddle, where the reins land: the middle of the plate part the "fit" beat lights. */
const saddle = (() => {
  // The second beat is the fit: the saddle on the horse.
  const { region } = story.beats[1];
  return { x: (region.left + region.width / 2) / 100, y: (region.top + region.height / 2) / 100 };
})();

/** A box's size and its content column, in pixels from the box's left edge. */
type Column = { readonly width: number; readonly left: number; readonly span: number };

/** Where the story's content column sits in `element`, measured again when either resizes. */
function useColumn(element: RefObject<HTMLElement | null>, extra?: (box: DOMRect) => void) {
  const [column, setColumn] = useState<Column>();
  useEffect(() => {
    const box = element.current;
    const head = box?.querySelector(".story-head");
    if (box === null || box === undefined || head === null || head === undefined) return undefined;
    const measure = () => {
      const outer = box.getBoundingClientRect();
      const inner = head.getBoundingClientRect();
      setColumn({ width: outer.width, left: inner.left - outer.left, span: inner.width });
      extra?.(outer);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(head);
    return () => observer.disconnect();
    // The measure reads the element's children; it runs again when the element resizes.
  }, [element]);
  return column;
}

/** A rein draws in brass over `draw` seconds after `delay`, holds, then gives way to its blue. */
const reinDraw = { draw: 0.5, hold: 0.9, fade: 0.8 } as const;

/**
 * One rein, drawn from `d`: dashed while it is only planned, blue once it is a link, and drawn
 * again in brass when the last command made it.
 */
function Rein({
  d,
  state,
  run,
  delay,
}: {
  readonly d: string;
  readonly state: "planned" | "made" | "fresh";
  readonly run: number;
  readonly delay: number;
}) {
  const still = useReducedMotion() === true;
  const drawing = state === "fresh" && still === false;
  return (
    <>
      <motion.path
        key={`base-${drawing ? run : 0}`}
        className="rein"
        data-state={state}
        d={d}
        initial={drawing ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: reinDraw.fade, delay: delay + reinDraw.draw + reinDraw.hold }}
      />
      {drawing ? (
        <motion.path
          key={`lit-${run}`}
          className="rein"
          data-state="lit"
          d={d}
          initial={{ pathLength: 0, opacity: 1 }}
          animate={{ pathLength: 1, opacity: [1, 1, 0] }}
          transition={{
            pathLength: { duration: reinDraw.draw, delay, ease },
            opacity: {
              duration: reinDraw.draw + reinDraw.hold + reinDraw.fade,
              delay,
              times: [
                0,
                (reinDraw.draw + reinDraw.hold) / (reinDraw.draw + reinDraw.hold + reinDraw.fade),
                1,
              ],
            },
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Direction A, the seam: the reins leave the demo window's bottom edge and run straight down
 * through the space under it, one per link the demo has made, or dashed guides before it has made
 * any. They carry on in the story frame, which picks them up at the same places.
 */
function ReinsSeam({ stage }: { readonly stage: RefObject<HTMLElement | null> }) {
  const column = useColumn(stage);
  const beat = useDemoBeat();
  if (column === undefined) return null;
  const reins = layoutReins(beat.total, beat.fresh, reinSpan(column.left, column.span));
  return (
    <svg className="transition-seam reins" aria-hidden="true">
      {reins.map((rein, index) => (
        <Rein
          key={`${index}-${rein.x}`}
          d={`M ${rein.x} 0 L ${rein.x} 1000`}
          state={rein.state}
          run={beat.changes}
          delay={0}
        />
      ))}
    </svg>
  );
}

/** The story frame's box, its column, and where the saddle and the plate's top edge sit in it. */
type Frame = Column & {
  readonly height: number;
  readonly target: { readonly x: number; readonly y: number };
  readonly bend: number;
  /** Where the heading and its intro end, so narrow screens can dim the reins behind them. */
  readonly headBottom: number;
};

/**
 * Measures the story frame for the reins: the column, the plate's saddle and its top edge, and the
 * heading's foot. The plate is measured, not the figure: on narrow screens the figure also holds
 * the captions under the plate.
 */
function useReinFrame(frame: RefObject<HTMLElement | null>) {
  const [plate, setPlate] = useState<Omit<Frame, keyof Column>>();
  const column = useColumn(frame, (outer) => {
    const drawing = frame.current?.querySelector(".story-plate");
    const head = frame.current?.querySelector(".story-head");
    if (drawing === null || drawing === undefined || head === null || head === undefined) return;
    const box = drawing.getBoundingClientRect();
    const top = box.top - outer.top;
    setPlate({
      height: outer.height,
      target: { x: box.left - outer.left + box.width * saddle.x, y: top + box.height * saddle.y },
      bend: Math.max(0, top - 24),
      headBottom: head.getBoundingClientRect().bottom - outer.top,
    });
  });
  return column === undefined || plate === undefined ? undefined : { ...column, ...plate };
}

/**
 * Direction A, the frame: the reins come down from the top of the story frame where the seam
 * left them, bend over the plate and land on the saddle, whose buckle beats once per command.
 */
function ReinsFrame({ frame }: { readonly frame: RefObject<HTMLElement | null> }) {
  const box = useReinFrame(frame);
  const beat = useDemoBeat();
  const layer = useRef<HTMLDivElement>(null);
  const headBottom = box?.headBottom;
  // The stylesheet dims the reins above the heading's foot on narrow screens.
  useEffect(() => {
    if (headBottom !== undefined)
      layer.current?.style.setProperty("--head-bottom", `${headBottom}px`);
  }, [headBottom]);
  if (box === undefined) return null;
  const reins = layoutReins(beat.total, beat.fresh, reinSpan(box.left, box.span));
  return (
    <div ref={layer} className="transition-frame" aria-hidden="true">
      <svg className="reins" viewBox={`0 0 ${box.width} ${box.height}`}>
        {reins.map((rein, index) => (
          <Rein
            key={`${index}-${rein.x}`}
            d={reinPath(rein.x, box.target, box.bend)}
            state={rein.state}
            run={beat.changes}
            delay={0.25}
          />
        ))}
      </svg>
      <span
        className="rein-buckle"
        data-made={beat.total > 0}
        style={{ left: box.target.x, top: box.target.y }}
      />
      {beat.commands > 0 ? (
        <motion.span
          key={`buckle-${beat.commands}`}
          className="rein-buckle"
          data-lit="true"
          data-intro-accent=""
          style={{ left: box.target.x, top: box.target.y }}
          initial={{ opacity: 0, transform: "scale(0.6)" }}
          animate={{ opacity: [0, 1, 0], transform: ["scale(0.6)", "scale(1.8)", "scale(2.6)"] }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
      ) : null}
    </div>
  );
}

/** How many ticks the plotter's rule carries. */
const tickCount = 32;

/**
 * Direction B: a drafting rule draws the plate in as the story scrolls up under the demo, the
 * plate showing above the rule and the bare sheet below it. Once drawn, the rule rests under the
 * plate as its scale, one tick lit per link the demo has made, the newest in brass. Under reduced
 * motion, and before the page runs, the plate is drawn and the rule rests.
 */
function PlotterPlate({ children }: { readonly children: ReactNode }) {
  const still = useReducedMotion() === true;
  const plotter = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  // The rule sets off once the plate's top edge is on screen and rests by the time it reaches the
  // upper third, where the pinned frame holds it, so the drawing happens in view.
  const { scrollYProgress: draw } = useScroll({
    target: plotter,
    offset: ["start 85%", "start 35%"],
  });
  // The stylesheet rests the rule at `--draw: 1`; the scroll moves it only while the page runs.
  const place = (value: number) => plotter.current?.style.setProperty("--draw", String(value));
  useMotionValueEvent(draw, "change", (value) => {
    if (still === false) place(value);
  });
  useEffect(() => {
    place(still ? 1 : draw.get());
    setLive(still === false);
  }, [still, draw]);
  const beat = useDemoBeat();
  const ticks = rulerTicks(beat.total, beat.fresh, tickCount);
  return (
    <div ref={plotter} className="plotter" data-drawing={live}>
      <div className="plotter-sheet">{children}</div>
      <div className="plotter-rule" aria-hidden="true">
        <span className="plotter-ticks">
          {ticks.map((tick, index) => (
            <span key={index} className="plotter-tick" data-state={tick} />
          ))}
        </span>
        <span className="plotter-label">{`${beat.total} links`}</span>
      </div>
    </div>
  );
}

/** How many legs a lap of the track has: the runner moves one per command. */
const legs = 10;

/** How far in each inner lane sits, as a share of the outer lane. */
const laneInset = 0.14;

/** The runner on the outer lane, a leg further round for each command the demo runs. */
function Runner({ commands }: { readonly commands: number }) {
  const still = useReducedMotion() === true;
  const lap = useMotionValue(commands / legs);
  useEffect(() => {
    const target = commands / legs;
    if (still) {
      lap.set(target);
      return undefined;
    }
    const controls = animate(lap, target, { duration: 1.4, ease });
    return () => controls.stop();
  }, [commands, still, lap]);
  const left = useTransform(lap, (fraction) => `${trackPoint(fraction).left}%`);
  const top = useTransform(lap, (fraction) => `${trackPoint(fraction).top}%`);
  return <motion.span className="track-runner" style={{ left, top }} />;
}

/**
 * Direction C: the plate's racetrack laid across the seam, its top half rounding the demo
 * window's foot and its bottom half in the space above the story's heading. A lane for each place
 * the demo links into, and a brass runner a leg further round for each command.
 */
function TrackSeam() {
  const beat = useDemoBeat();
  const lanes = laneCount(beat.scopes);
  const start = trackPoint(0);
  return (
    <div className="transition-seam track" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        {Array.from({ length: lanes }, (_, lane) => {
          const radius = 50 * (1 - lane * laneInset);
          return (
            <motion.ellipse
              key={lane}
              className="track-lane"
              cx="50"
              cy="50"
              rx={radius}
              ry={radius}
              initial={lane === 0 ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, ease }}
            />
          );
        })}
      </svg>
      <span className="track-start" style={{ left: `${start.left}%`, top: `${start.top}%` }} />
      <Runner commands={beat.commands} />
    </div>
  );
}

/**
 * The transition's part that sits across the seam between the hero and the story, in the story's
 * stage but reaching up under the demo window.
 */
export function TransitionSeam({
  choice,
  stage,
}: {
  readonly choice: Transition;
  readonly stage: RefObject<HTMLElement | null>;
}) {
  if (choice === "reins") return <ReinsSeam stage={stage} />;
  if (choice === "track") return <TrackSeam />;
  return null;
}

/** The transition's part inside the pinned story frame, behind the heading and the plate. */
export function TransitionFrame({
  choice,
  frame,
}: {
  readonly choice: Transition;
  readonly frame: RefObject<HTMLElement | null>;
}) {
  return choice === "reins" ? <ReinsFrame frame={frame} /> : null;
}

/** The plate, drawn in by the plotter's rule in direction B, and as it is otherwise. */
export function TransitionPlate({
  choice,
  children,
}: {
  readonly choice: Transition;
  readonly children: ReactNode;
}) {
  return choice === "plotter" ? <PlotterPlate>{children}</PlotterPlate> : children;
}
