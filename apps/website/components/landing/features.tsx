import { motion } from "motion/react";
import { useRef, type ReactNode, type RefObject } from "react";
import { features } from "./content.ts";
import { corners, InView, settle } from "./drafting-sheet.tsx";
import { Illustration } from "./illustration.tsx";
import { InlineCode, Proof } from "./inline-code.tsx";
import {
  usePinned,
  useScrollFrames,
  type ScrollFrames,
  type ScrollRange,
} from "./scroll-motion.ts";

/** A part that fades in and rises `rise` pixels between `from` and `to` of its scroll range. */
const reveal = (from: number, to: number, rise = 12): ScrollFrames => ({
  opacity: [0, 0, 1, 1],
  transform: [
    `translateY(${rise}px)`,
    `translateY(${rise}px)`,
    "translateY(0px)",
    "translateY(0px)",
  ],
  times: [0, from, to, 1],
});

/** A part whose keyframes follow `target` through `range` of the viewport. */
function ScrollPart({
  target,
  range,
  frames,
  className,
  as = "div",
  children,
}: {
  readonly target: RefObject<HTMLElement | null>;
  readonly range: ScrollRange;
  readonly frames: ScrollFrames;
  readonly className?: string;
  readonly as?: "div" | "li" | "span";
  readonly children?: ReactNode;
}) {
  const element = useRef<HTMLElement | null>(null);
  const attach = (node: HTMLElement | null) => {
    element.current = node;
  };
  useScrollFrames(element, target, frames, range);
  const Tag = as;
  return (
    <Tag ref={attach} className={className}>
      {children}
    </Tag>
  );
}

/** The section's heading and its intro line. */
function FeaturesHead() {
  return (
    <InView className="features-head">
      <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
        Features
      </motion.p>
      <motion.h2 id="features-title" data-intro="" variants={settle(0.06, 16)}>
        {features.heading}
      </motion.h2>
      <motion.p className="features-intro" data-intro="" variants={settle(0.16, 10)}>
        {features.intro}
      </motion.p>
    </InView>
  );
}

/** The pinned agents moment's whole run, from the frame pinning to it letting go. */
const pinRun: ScrollRange = ["start start", "end end"];

/** Where each of the three links lands in the agents moment, as shares of its scroll. */
const linkBeats = [
  { from: 0.16, to: 0.28 },
  { from: 0.34, to: 0.46 },
  { from: 0.52, to: 0.64 },
] as const;

/**
 * One skill folder and the three links one sync makes to it. As the moment scrolls, the spine
 * draws down from the folder and each agent's link lands in turn, its mark flashing brass as it
 * arrives: one cause, three effects, in the order a sync writes them.
 */
function LinkFigure({
  track,
  pinned,
}: {
  readonly track: RefObject<HTMLElement | null>;
  readonly pinned: boolean;
}) {
  const { links } = features.agents;
  const first = linkBeats[0];
  const last = linkBeats[2];
  // Pinned, the sync follows the moment's run; otherwise it follows the figure's own pass up the
  // screen, so the links land while the figure is in view.
  const figure = useRef<HTMLElement>(null);
  const target = pinned ? track : figure;
  const range: ScrollRange = pinned ? pinRun : ["start 0.95", "end 0.45"];
  return (
    <figure
      ref={figure}
      className="links-figure"
      aria-label={`One sync links ${links.source} into ${links.destinations.map((link) => link.path).join(", ")}.`}
    >
      <div className="links-source">
        <span className="links-origin" aria-hidden="true" />
        <code>{links.source}</code>
      </div>
      <ScrollPart
        target={target}
        range={range}
        className="links-spine"
        frames={{
          transform: ["scaleY(0)", "scaleY(0)", "scaleY(1)", "scaleY(1)"],
          times: [0, first.from, last.to, 1],
        }}
      />
      <ol>
        {links.destinations.map((link, index) => {
          const at = linkBeats[index] ?? first;
          return (
            <ScrollPart
              key={link.path}
              as="li"
              target={target}
              range={range}
              className="links-row"
              frames={{
                opacity: [0, 0, 1, 1],
                transform: [
                  "translateX(-16px)",
                  "translateX(-16px)",
                  "translateX(0px)",
                  "translateX(0px)",
                ],
                times: [0, at.from, at.to, 1],
              }}
            >
              <span className="links-mark" aria-hidden="true">
                <ScrollPart
                  as="span"
                  target={target}
                  range={range}
                  className="links-mark-lit"
                  frames={{
                    opacity: [0, 0, 1, 0, 0],
                    times: [0, at.to - 0.04, at.to, at.to + 0.1, 1],
                  }}
                />
              </span>
              <code>{link.path}</code>
              <span className="links-agent">{link.agent}</span>
            </ScrollPart>
          );
        })}
      </ol>
    </figure>
  );
}

/**
 * Agents: a pinned moment. The headline and its first line arrive as the moment comes into view;
 * as it holds, the link figure plays a sync, then the rest of the words and the proof follow, while
 * the harness horse drifts slowly behind. Narrow screens and reduced motion do not pin: the same
 * parts play as the block scrolls past, or rest.
 */
function AgentsBlock() {
  const track = useRef<HTMLElement>(null);
  const after = useRef<HTMLDivElement>(null);
  const pinned = usePinned();
  const block = features.agents;
  return (
    <article ref={track} className="agents-track" aria-labelledby="agents-title">
      <div className="agents-pin">
        <div className="landing-shell agents-grid">
          <div className="agents-words">
            <InView className="feature-lead">
              <motion.h3 id="agents-title" data-intro="" variants={settle(0, 16)}>
                {block.title}
              </motion.h3>
              <motion.p data-intro="" variants={settle(0.08, 10)}>
                {block.lines[0]}
              </motion.p>
            </InView>
            <LinkFigure track={track} pinned={pinned} />
            <div ref={after}>
              <ScrollPart
                target={pinned ? track : after}
                range={pinned ? pinRun : ["start 0.95", "start 0.7"]}
                className="feature-after"
                frames={pinned ? reveal(0.7, 0.84) : reveal(0, 1)}
              >
                <p>{block.lines[1]}</p>
                <p className="feature-note">
                  <InlineCode text={block.note} />
                </p>
                <Proof text={block.proof} />
              </ScrollPart>
            </div>
          </div>
          <ScrollPart
            target={track}
            range={pinned ? pinRun : ["start end", "end start"]}
            className="agents-art"
            frames={{
              transform: ["translateY(56px) scale(1.04)", "translateY(-56px) scale(1)"],
            }}
          >
            <Illustration
              name="feature-harness"
              widths={[640, 1024]}
              sizes="(max-width: 1024px) 100vw, 720px"
              width={1536}
              height={1024}
              alt={block.alt}
            />
          </ScrollPart>
        </div>
      </div>
    </article>
  );
}

/**
 * Team: a free-scrolling spread. The saddled horse runs in from the left at its own, slower pace
 * (parallax), and the words arrive beside it one after another, with shrinking gaps: headline,
 * lines, the supporting line, then the proof.
 */
function TeamBlock() {
  const block = useRef<HTMLElement>(null);
  const team = features.team;
  return (
    <article ref={block} className="team" aria-labelledby="team-title">
      <ScrollPart
        target={block}
        range={["start end", "end start"]}
        className="team-art"
        frames={{ transform: ["translate(-40px, 80px)", "translate(24px, -80px)"] }}
      >
        <Illustration
          name="feature-saddle"
          widths={[640, 1024]}
          sizes="(max-width: 1024px) 100vw, 760px"
          width={1536}
          height={1024}
          alt={team.alt}
        />
      </ScrollPart>
      <InView className="team-words" amount={0.5}>
        <motion.h3 id="team-title" data-intro="" variants={settle(0, 16)}>
          <InlineCode text={team.title} />
        </motion.h3>
        <motion.p data-intro="" variants={settle(0.1, 12)}>
          {team.lines[0]}
        </motion.p>
        <motion.p data-intro="" variants={settle(0.17, 10)}>
          {team.lines[1]}
        </motion.p>
        <motion.p className="feature-note" data-intro="" variants={settle(0.22, 0)}>
          {team.note}
        </motion.p>
        <motion.div data-intro="" variants={settle(0.26, 0)}>
          <Proof text={team.proof} />
        </motion.div>
      </InView>
    </article>
  );
}

/**
 * Docs: the reader stands up. The words arrive first; then, as the page scrolls, the reader's
 * window rises out of the sheet, leaning back on its top edge, comes upright and lands under
 * drafting marks, as the demo window does in the hero.
 */
function DocsBlock() {
  const stage = useRef<HTMLDivElement>(null);
  const docs = features.docs;
  const range: ScrollRange = ["start end", "start 0.25"];
  return (
    <article className="docs" aria-labelledby="docs-title">
      <InView className="docs-words" amount={0.5}>
        <motion.h3 id="docs-title" data-intro="" variants={settle(0, 16)}>
          {docs.title}
        </motion.h3>
        <div className="docs-lines">
          <motion.p data-intro="" variants={settle(0.1, 12)}>
            <InlineCode text={docs.lines[0]} />
          </motion.p>
          <motion.p data-intro="" variants={settle(0.17, 10)}>
            <InlineCode text={docs.lines[1]} />
          </motion.p>
          <motion.div data-intro="" variants={settle(0.24, 0)}>
            <Proof text={docs.proof} />
          </motion.div>
        </div>
      </InView>
      <div ref={stage} className="docs-stage">
        <ScrollPart
          target={stage}
          range={range}
          className="docs-window"
          frames={{
            opacity: [0.3, 1, 1],
            transform: [
              "translateY(72px) rotateX(22deg) scale(0.9)",
              "translateY(24px) rotateX(9deg) scale(0.96)",
              "translateY(0px) rotateX(0deg) scale(1)",
            ],
            times: [0, 0.5, 1],
          }}
        >
          <Illustration
            name="docs-reader"
            widths={[640, 1280]}
            sizes="(max-width: 1024px) 100vw, 1100px"
            width={2268}
            height={1560}
            alt={docs.alt}
          />
        </ScrollPart>
        {corners.map((corner) => (
          <ScrollPart
            key={corner.name}
            as="span"
            target={stage}
            range={range}
            className="docs-mark"
            frames={{
              opacity: [0, 0, 1],
              transform: [
                `translate(${corner.x}px, ${corner.y}px)`,
                `translate(${corner.x}px, ${corner.y}px)`,
                "translate(0px, 0px)",
              ],
              times: [0, 0.75, 1],
            }}
          >
            <span className="drafting-mark" data-corner={corner.name} />
          </ScrollPart>
        ))}
      </div>
    </article>
  );
}

/** The smaller features, one line and one command each, arriving with shrinking gaps. */
const alsoDelays = [0.04, 0.1, 0.14] as const;

/** The smaller features, one line and one command each. */
function AlsoRow() {
  const { also } = features;
  return (
    <InView className="also" amount={0.4}>
      <motion.h3 className="also-heading" data-intro="" variants={settle(0, 0)}>
        {also.heading}
      </motion.h3>
      <div className="also-items">
        {also.items.map((item, index) => (
          <motion.article
            key={item.title}
            className="also-item"
            data-intro=""
            variants={settle(alsoDelays[index] ?? alsoDelays[2], 10)}
          >
            <h4>{item.title}</h4>
            <p>{item.text}</p>
            <Proof text={item.proof} />
          </motion.article>
        ))}
      </div>
      <motion.p className="also-more" data-intro="" variants={settle(0.2, 0)}>
        <a href={features.more.href}>{features.more.label}</a>
      </motion.p>
    </InView>
  );
}

/**
 * The features, one lens each, in a varied rhythm down the blueprint sheet: a pinned moment for
 * the agents, a parallax spread for the team, the docs reader standing up, and a quiet row for the
 * rest.
 */
export function Features() {
  return (
    <section id="features" className="landing-section features" aria-labelledby="features-title">
      <div className="landing-shell">
        <FeaturesHead />
      </div>
      <AgentsBlock />
      <div className="landing-shell">
        <TeamBlock />
        <DocsBlock />
        <AlsoRow />
      </div>
    </section>
  );
}
