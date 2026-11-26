import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { layoutReins, reinPath, reinSpan, tallyLinks } from "../../demo/story-transition.ts";
import { story } from "./content.ts";
import { useDemoLinks } from "./demo-links.tsx";
import { ease } from "./drafting-sheet.tsx";

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
 * The reins across the seam: they leave the demo window's bottom edge and run straight down
 * through the space under it, one per link the demo has made, or dashed guides before it has made
 * any. They carry on in the story frame, which picks them up at the same places. It sits in the
 * story's stage but reaches up under the demo window.
 */
export function ReinsSeam({ stage }: { readonly stage: RefObject<HTMLElement | null> }) {
  const column = useColumn(stage);
  const beat = useDemoBeat();
  if (column === undefined) return null;
  const reins = layoutReins(beat.total, beat.fresh, reinSpan(column.left, column.span));
  return (
    <svg className="transition-seam" aria-hidden="true">
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
 * The reins in the pinned story frame, behind the heading and over the plate: they come down from
 * the top of the frame where the seam left them, bend over the plate and land on the saddle, whose
 * buckle beats once per command.
 */
export function ReinsFrame({ frame }: { readonly frame: RefObject<HTMLElement | null> }) {
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
