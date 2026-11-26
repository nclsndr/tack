import { motion, type Variants } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { story } from "./content.ts";
import { corners, ease, InView, settle } from "./drafting-sheet.tsx";
import { Illustration } from "./illustration.tsx";
import { InlineCode, Proof } from "./inline-code.tsx";
import { ReinsFrame, ReinsSeam } from "./story-transition.tsx";

/**
 * Which beat of the story the page is on: 0 before the stage pins, then one beat per stretch of
 * the stage's scroll, up to `count`.
 */
function useStoryBeat(stage: RefObject<HTMLElement | null>, count: number) {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const element = stage.current;
    if (element === null) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const travel = box.height - window.innerHeight;
      const progress = travel <= 0 ? 0 : Math.min(1, Math.max(0, -box.top / travel));
      setBeat(Math.min(count, Math.floor(progress * (count + 1))));
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [stage, count]);
  return beat;
}

/** A box on the plate, in percentages of its width and height. */
type Region = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

const box = (region: Region) => ({
  left: `${region.left}%`,
  top: `${region.top}%`,
  width: `${region.width}%`,
  height: `${region.height}%`,
});

/** How far a lit part's edge feathers into the plate, in percentages of the plate. */
const feather = 2.5;

/**
 * A mask that keeps only `region` of the plate, feathered at its edges, so a copy of the plate
 * shows that part alone and melts into the rest.
 */
const maskTo = (region: Region) => {
  const right = region.left + region.width;
  const bottom = region.top + region.height;
  const band = (from: number, to: number, side: string) =>
    `linear-gradient(${side}, transparent ${from - feather}%, #000 ${from + feather}%, #000 ${to - feather}%, transparent ${to + feather}%)`;
  return `${band(region.left, right, "90deg")}, ${band(region.top, bottom, "180deg")}`;
};

/** A beat's part lights in 600ms and goes out in 400ms, on the brand's strong ease-out. */
const light = (on: boolean) => ({ duration: on ? 0.6 : 0.4, ease });

/**
 * The marks on one beat's part of the plate, the hero window's marks: out and faint, then closing
 * in when it lights.
 */
function RegionMarks({ region, on }: { readonly region: Region; readonly on: boolean }) {
  return (
    <div className="story-region" aria-hidden="true" style={box(region)}>
      {corners.map((corner) => (
        <motion.span
          key={corner.name}
          className="drafting-mark"
          data-corner={corner.name}
          initial={false}
          animate={
            on
              ? { opacity: 1, transform: "translate(0px, 0px)" }
              : { opacity: 0, transform: `translate(${corner.x}px, ${corner.y}px)` }
          }
          transition={light(on)}
        />
      ))}
    </div>
  );
}

const captionMotion: Variants = {
  off: { opacity: 0, transform: "translateY(10px)" },
  on: { opacity: 1, transform: "translateY(0px)" },
};

/**
 * The horse plate in the sheet's blue line work. Each beat brings its part of the plate back in
 * colour, so the lit part reads as the one in focus.
 */
function HorsePlate({ beat }: { readonly beat: number }) {
  const plate = (alt: string) => (
    <Illustration
      name="hero-saddle"
      widths={[768, 1280, 1916]}
      sizes="100vw"
      width={1916}
      height={821}
      alt={alt}
    />
  );
  return (
    <div className="story-plate">
      {plate(
        "Illustration: a blue wireframe horse wearing a tan leather saddle, between blueprint studies of its gait and a racetrack.",
      )}
      {story.beats.map((step, index) => (
        <motion.div
          key={step.id}
          className="story-colour"
          aria-hidden="true"
          style={{
            maskImage: maskTo(step.region),
            WebkitMaskImage: maskTo(step.region),
            maskComposite: "intersect",
            WebkitMaskComposite: "source-in",
          }}
          initial={false}
          animate={{ opacity: beat === index + 1 ? 1 : 0 }}
          transition={light(beat === index + 1)}
        >
          {plate("")}
        </motion.div>
      ))}
    </div>
  );
}

/**
 * The metaphor of what the demo showed, on the blueprint plate straight under the demo window,
 * pinned while the page scrolls: the agent is the horse, Tack the gear. The heading and its intro
 * hold at the top; each beat brings one part of the plate back in colour, drafting marks close in
 * on it and its caption rises in, with a command or fact as its proof. On narrow screens and under
 * reduced motion the beats stack under the plate. The demo's links run down from the window into
 * the plate like reins and land on the saddle (`story-transition.tsx`): decoration that follows
 * the demo but never waits for it.
 */
export function Story() {
  const stage = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const beat = useStoryBeat(stage, story.beats.length);
  return (
    <section ref={stage} className="story-stage" data-beat={beat} aria-labelledby="story-title">
      <ReinsSeam stage={stage} />
      <div ref={frame} className="story-sticky">
        <ReinsFrame frame={frame} />
        <InView className="landing-shell story-head">
          <motion.h2 id="story-title" data-intro="" variants={settle(0, 16)}>
            {story.heading}
          </motion.h2>
          <motion.p className="story-intro" data-intro="" variants={settle(0.12, 10)}>
            {story.intro}
          </motion.p>
        </InView>
        <div className="story-figure">
          <HorsePlate beat={beat} />
          {story.beats.map((step, index) => (
            <RegionMarks key={step.id} region={step.region} on={beat === index + 1} />
          ))}
          <ol className="story-captions">
            {story.beats.map((step, index) => (
              <motion.li
                key={step.id}
                className="story-caption"
                style={{ left: `${step.caption.left}%`, top: `${step.caption.top}%` }}
                variants={captionMotion}
                initial={false}
                animate={beat === index + 1 ? "on" : "off"}
                transition={{ duration: 0.5, delay: beat === index + 1 ? 0.15 : 0, ease }}
              >
                <span className="story-caption-step">{`0${index + 1}`}</span>
                <strong>{step.title}</strong>
                <span>
                  <InlineCode text={step.text} />
                </span>
                <Proof text={step.proof} />
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
