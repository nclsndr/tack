import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { layoutArcs } from "../../demo/link-arcs.ts";
import { useDemoLinks } from "./demo-links.tsx";
import { useHeroField, type HeroCopyBox } from "./hero-intro.tsx";

/** How far the layer reaches above the copy and below it, and how far under it the origin sits. */
const reach = { above: 140, below: 110, origin: 24 } as const;

/** Travel out from the origin: a strong ease-in-out. */
const travel = [0.77, 0, 0.175, 1] as const;

/** The beats of one command, in seconds. */
const beat = {
  /** The origin lights first: the command is the cause of everything after it. */
  cause: 0.6,
  /** Then the kept files' arcs brighten once. */
  kept: 0.15,
  keptRun: 0.6,
  /** New links leave the origin after the cause, a stagger apart, the whole stagger capped. */
  start: 0.15,
  stagger: 0.06,
  staggerCap: 0.9,
  /** A link's travel to its mark, and its mark's arrival. */
  travel: 0.52,
  arrive: 0.16,
  /** Brass holds after a mark lands, then settles into blue. */
  hold: 1.2,
  settle: 0.9,
} as const;

/** A box of the copy's text, in pixels from the copy's top left corner. */
type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** Where the headline and the lead sit in the copy, measured again when the copy's box changes. */
function useTextBoxes(copyBox: HeroCopyBox | undefined) {
  const [boxes, setBoxes] = useState<ReadonlyArray<Box>>([]);
  useEffect(() => {
    const copy = document.querySelector(".hero-copy");
    if (copy === null || copyBox === undefined) return;
    const origin = copy.getBoundingClientRect();
    const parts = [
      document.getElementById("hero-title"),
      document.querySelector(".landing-hero-aside"),
    ];
    setBoxes(
      parts.flatMap((part) => {
        if (part === null) return [];
        const rect = part.getBoundingClientRect();
        return [
          {
            left: rect.left - origin.left,
            top: rect.top - origin.top,
            width: rect.width,
            height: rect.height,
          },
        ];
      }),
    );
  }, [copyBox]);
  return boxes;
}

/** How much of the drawing shows under the copy: less under the lead, whose text is smaller. */
const dim = { headline: 0.3, lead: 0.15 } as const;

/**
 * A mask layer that lets `keep` of the drawing through over a text box, feathered out to full a
 * little beyond it, so the drawing fades under the text instead of stopping at its edge.
 */
const holeOver = (box: Box, keep: number) => {
  const x = Math.round(box.left + box.width / 2);
  const y = Math.round(reach.above + box.top + box.height / 2);
  const size = `${Math.round(box.width * 0.62)}px ${Math.round(box.height * 0.75)}px`;
  return `radial-gradient(${size} at ${x}px ${y}px, rgb(0 0 0 / ${keep}) 68%, #000 100%)`;
};

/** One file's arc: the upper half of a flat ellipse over the origin. */
function Arc({
  radius,
  flat,
  origin,
  lit,
}: {
  readonly radius: number;
  readonly flat: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly lit: boolean;
}) {
  const height = radius * flat;
  return (
    <svg
      className="field-arc"
      data-lit={lit}
      style={{
        left: origin.x - radius,
        top: origin.y - height,
        width: radius * 2,
        height: height + 1,
      }}
      viewBox={`0 0 ${radius * 2} ${height + 1}`}
      aria-hidden="true"
    >
      <path d={`M 0 ${height} A ${radius} ${height} 0 0 1 ${radius * 2} ${height}`} />
    </svg>
  );
}

/**
 * The links as marks on arcs fanned over one origin under the copy: each real file an arc, each
 * link a mark on its file's arc, the home and each project a sector of the fan. A command lights
 * the origin; the kept files' arcs brighten; each new link travels out from the origin to its mark,
 * inner arcs first, lands in brass and settles into blue.
 */
function Arcs({ width, originY }: { readonly width: number; readonly originY: number }) {
  const state = useDemoLinks();
  if (state === undefined) return null;
  const { arcs, marks } = layoutArcs(state.field, width);
  const origin = { x: width / 2, y: originY };
  const fresh = marks.filter((mark) => mark.fresh).length;
  const step = Math.min(beat.stagger, beat.staggerCap / Math.max(1, fresh));
  const run = state.changes;
  const firstOf = (file: number) =>
    Math.min(...marks.filter((mark) => mark.file === file && mark.fresh).map((mark) => mark.order));
  return (
    <>
      <span className="field-origin" data-intro="" style={{ left: origin.x, top: origin.y }} />
      {run > 0 ? (
        <motion.span
          key={`origin-${run}`}
          className="field-origin"
          data-lit="true"
          data-intro-accent=""
          style={{ left: origin.x, top: origin.y }}
          initial={{ opacity: 0, transform: "scale(0.6)" }}
          animate={{ opacity: [0, 1, 0], transform: ["scale(0.6)", "scale(1.6)", "scale(2.2)"] }}
          transition={{ duration: beat.cause, ease: "easeOut" }}
        />
      ) : null}
      {arcs.map((arc, index) => {
        // A file that is new with this command draws its arc as its first link leaves the origin.
        const drawn = arc.fresh && arc.kept === false;
        return (
          <span key={`${arc.key}-${drawn ? run : 0}`}>
            <motion.span
              className="field-arc-holder"
              data-intro=""
              initial={drawn ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: beat.start + firstOf(index) * step }}
            >
              <Arc radius={arc.radius} flat={arc.flat} origin={origin} lit={false} />
            </motion.span>
            {arc.kept && run > 0 ? (
              <motion.span
                key={`kept-${run}`}
                className="field-arc-holder"
                data-intro-accent=""
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: beat.keptRun, delay: beat.kept, ease: "easeInOut" }}
              >
                <Arc radius={arc.radius} flat={arc.flat} origin={origin} lit />
              </motion.span>
            ) : null}
          </span>
        );
      })}
      {marks.map((mark) => {
        const at = beat.start + mark.order * step;
        const point = { x: mark.x, y: originY + mark.y };
        const landed = at + beat.travel;
        const length = beat.arrive + beat.hold + beat.settle;
        return (
          <span key={`${mark.key}-${mark.fresh ? run : 0}`}>
            <motion.span
              className="field-mark"
              data-intro=""
              style={{ left: point.x, top: point.y }}
              initial={mark.fresh ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: beat.arrive, delay: landed }}
            />
            {mark.fresh ? (
              <>
                <motion.span
                  className="field-traveller"
                  data-intro-accent=""
                  style={{ left: origin.x, top: origin.y }}
                  initial={{ opacity: 0, transform: "translate(0px, 0px)" }}
                  animate={{
                    opacity: [0, 1, 1, 0],
                    transform: `translate(${point.x - origin.x}px, ${point.y - origin.y}px)`,
                  }}
                  transition={{
                    transform: { duration: beat.travel, delay: at, ease: travel },
                    opacity: { duration: beat.travel + 0.12, delay: at, times: [0, 0.1, 0.8, 1] },
                  }}
                />
                <motion.span
                  className="field-mark"
                  data-lit="true"
                  data-intro-accent=""
                  style={{ left: point.x, top: point.y }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 1, 0] }}
                  transition={{
                    duration: length,
                    delay: landed,
                    times: [0, beat.arrive / length, (beat.arrive + beat.hold) / length, 1],
                  }}
                />
              </>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

/**
 * The demo's links drawn behind the copy, across the whole page, as arcs over one origin. The
 * layer rides with the copy as the hero pins, so the copy always sits on the same part of it; it
 * fades out at its top and bottom edges, clear of the navigation, and a mask measured from the
 * headline and the lead dims the drawing under the text so the copy always reads first. The layer
 * is mounted from the first render, so the pin attaches the copy's rise to it at once.
 */
export function HeroField() {
  const { field, copyBox } = useHeroField();
  const texts = useTextBoxes(copyBox);
  const mask = [
    "linear-gradient(to bottom, transparent 0, #000 24%, #000 86%, transparent 100%)",
    ...texts.map((box, index) => holeOver(box, index === 0 ? dim.headline : dim.lead)),
  ].join(", ");
  return (
    <div
      ref={field}
      className="hero-field"
      aria-hidden="true"
      style={{
        top: (copyBox?.top ?? 0) - reach.above,
        height: copyBox === undefined ? 0 : reach.above + copyBox.height + reach.below,
        maskImage: mask,
        WebkitMaskImage: mask,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }}
    >
      {copyBox === undefined ? null : (
        <Arcs width={copyBox.width} originY={reach.above + copyBox.height + reach.origin} />
      )}
    </div>
  );
}
