import { motion } from "motion/react";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { corners, ease, InView, settle } from "../landing/drafting-sheet.tsx";
import { Illustration } from "../landing/illustration.tsx";
import { InlineCode } from "../landing/inline-code.tsx";
import { useScrollFrames } from "../landing/scroll-motion.ts";
import { Terminal } from "../terminal.tsx";
import { days, steps, type Step } from "./content.ts";

/** A step's number on the route, from one: `01`, `02`… */
export const stepNumber = (index: number) => String(index + 1).padStart(2, "0");

/** The agents one sync links a skill into, with the folder each reads in a project. */
const agentLinks = {
  source: "~/skills/review",
  destinations: [
    { agent: "Claude Code", path: ".claude/skills/review" },
    { agent: "Codex", path: ".agents/skills/review" },
    { agent: "Cursor", path: ".cursor/skills/review" },
    { agent: "OpenCode", path: ".opencode/skills/review" },
    { agent: "Pi", path: ".pi/skills/review" },
  ],
} as const;

/**
 * The step the reader is on: the last step whose article crossed the reading line, a band a little
 * above the middle of the screen. Before the first step it is none.
 */
function useActiveStep(ids: ReadonlyArray<string>) {
  const [active, setActive] = useState<string | undefined>(undefined);
  const key = ids.join(" ");
  useEffect(() => {
    const elements = key
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((element) => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((entry) => entry.isIntersecting === true);
        if (hit !== undefined) setActive(hit.target.id);
      },
      { rootMargin: "-42% 0px -52% 0px" },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [key]);
  return active;
}

/**
 * The route rail beside the steps, on wide screens: each step as a station, grouped by day. The
 * spine fills as the walkthrough scrolls, and the station the reader is on lights brass.
 */
function RouteRail({
  track,
  active,
}: {
  readonly track: RefObject<HTMLElement | null>;
  readonly active: string | undefined;
}) {
  const fill = useRef<HTMLSpanElement>(null);
  useScrollFrames(fill, track, { transform: ["scaleY(0)", "scaleY(1)"] }, [
    "start 0.45",
    "end 0.55",
  ]);
  return (
    <nav className="route-rail" aria-label="Steps">
      <span className="route-rail-spine" aria-hidden="true">
        <span ref={fill} className="route-rail-fill" />
      </span>
      {days.map((day) => (
        <div key={day.id} className="route-rail-day">
          <p className="route-rail-label">{day.title}</p>
          <ol>
            {steps.map((step, index) =>
              step.day === day.id ? (
                <li key={step.id}>
                  <a
                    href={`#${step.id}`}
                    className="route-rail-station"
                    aria-current={active === step.id ? "step" : undefined}
                  >
                    <span className="links-mark" aria-hidden="true" />
                    <span className="route-rail-number">{stepNumber(index)}</span>
                    <span>{step.title.replace(/\.$/u, "")}</span>
                  </a>
                </li>
              ) : null,
            )}
          </ol>
        </div>
      ))}
    </nav>
  );
}

/** One sync's links: the skill folder, and the link it makes in each agent's folder. */
function LinksPlate() {
  return (
    <figure
      className="links-figure route-links"
      aria-label={`One sync links ${agentLinks.source} into ${agentLinks.destinations.map((link) => link.path).join(", ")}.`}
    >
      <div className="links-source">
        <span className="links-origin" aria-hidden="true" />
        <code>{agentLinks.source}</code>
      </div>
      <span className="links-spine route-links-spine" aria-hidden="true" />
      <ol>
        {agentLinks.destinations.map((link, index) => (
          <motion.li
            key={link.path}
            className="links-row"
            data-intro=""
            variants={settle(0.12 + index * 0.08, 0)}
          >
            <span className="links-mark" aria-hidden="true" />
            <code>{link.path}</code>
            <span className="links-agent">{link.agent}</span>
          </motion.li>
        ))}
      </ol>
    </figure>
  );
}

/**
 * A command on a proof slip, the landing's monospace chip, that wraps only between words: a flag
 * such as `--target-root` never breaks after its dashes.
 */
export function CommandChip({ text }: { readonly text: string }) {
  const words = text.split(" ");
  return (
    <code className="proof route-chip">
      {text.startsWith("tack ") ? (
        <span className="proof-prompt" aria-hidden="true">
          ${" "}
        </span>
      ) : null}
      {words.map((word, index) => (
        <Fragment key={index}>
          {index === 0 ? null : " "}
          <span className="route-word">{word}</span>
        </Fragment>
      ))}
    </code>
  );
}

/** A file of the team's source, in the terminal's frame. */
function CodeWindow({ file, text }: { readonly file: string; readonly text: string }) {
  if (import.meta.env.SSG_MD === true) return null;
  return (
    <figure className="tack-terminal">
      <figcaption className="tack-terminal-bar">
        <span className="tack-terminal-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>{file}</span>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

/** What a step shows as its evidence: the terminal, and a figure for the steps that have one. */
function StepEvidence({ step }: { readonly step: Step }) {
  return (
    <div className="route-evidence">
      {step.id === "sync" ? <LinksPlate /> : null}
      {step.code !== undefined ? <CodeWindow file={step.code.file} text={step.code.text} /> : null}
      {step.output !== undefined ? (
        <div>
          <Terminal
            title={step.output.cwd}
            commands={[step.output.command]}
            output={step.output.text}
          />
          {step.output.cut === undefined ? null : <p className="route-cut">{step.output.cut}</p>}
        </div>
      ) : null}
      {step.id === "docs" ? (
        <figure className="route-reader">
          <Illustration
            name="features-reader"
            widths={[640, 1280]}
            sizes="(max-width: 1024px) 100vw, 860px"
            width={2560}
            height={1600}
            alt="Screenshot: the Tack docs reader on project app, showing the team handbook's Releases page with its contents and a file-tree figure."
          />
          <figcaption className="route-cut">
            <code>tack docs serve</code> on this walkthrough's project: the team handbook, read from{" "}
            <code>~/team</code>.
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}

/**
 * One step: its number and title, then a plate with what you run beside what Tack does, and the
 * output that proves it. Drafting marks close in on the plate while the reader is on the step.
 */
function StepArticle({
  step,
  index,
  active,
}: {
  readonly step: Step;
  readonly index: number;
  readonly active: boolean;
}) {
  return (
    <article id={step.id} className="route-step" aria-labelledby={`${step.id}-title`}>
      <InView className="route-step-head" amount={0.3}>
        <motion.span className="route-step-number" data-intro="" variants={settle(0, 6)}>
          {stepNumber(index)}
        </motion.span>
        <motion.h3 id={`${step.id}-title`} data-intro="" variants={settle(0.04, 14)}>
          {step.title}
        </motion.h3>
        <motion.p data-intro="" variants={settle(0.1, 10)}>
          <InlineCode text={step.summary} />
        </motion.p>
      </InView>
      <div className="route-plate" data-active={active === true ? "true" : "false"}>
        {corners.map((corner) => (
          <motion.span
            key={corner.name}
            className="drafting-mark route-plate-mark"
            data-corner={corner.name}
            aria-hidden="true"
            initial={false}
            animate={
              active
                ? { opacity: 1, transform: "translate(0px, 0px)" }
                : { opacity: 0, transform: `translate(${corner.x}px, ${corner.y}px)` }
            }
            transition={{ duration: active ? 0.6 : 0.4, ease }}
          />
        ))}
        <InView className="route-plate-grid" amount={0.3}>
          <div className="route-you">
            <motion.p className="route-side" data-intro="" variants={settle(0, 0)}>
              You run
            </motion.p>
            <ol className="route-commands">
              {step.run.map((line, at) => (
                <motion.li key={line} data-intro="" variants={settle(0.06 + at * 0.06, 8)}>
                  <CommandChip text={line} />
                </motion.li>
              ))}
            </ol>
            {step.or === undefined ? null : (
              <motion.p className="route-or" data-intro="" variants={settle(0.24, 0)}>
                <InlineCode text={step.or} />
              </motion.p>
            )}
          </div>
          <div className="route-tack">
            <motion.p className="route-side" data-intro="" variants={settle(0.1, 0)}>
              Tack does
            </motion.p>
            <ul className="route-facts">
              {step.tack.map((fact, at) => (
                <motion.li key={fact} data-intro="" variants={settle(0.16 + at * 0.07, 8)}>
                  <span className="links-mark" aria-hidden="true" />
                  <span>
                    <InlineCode text={fact} />
                  </span>
                </motion.li>
              ))}
            </ul>
          </div>
        </InView>
        <InView amount={0.15}>
          <motion.div data-intro="" variants={settle(0.1, 16)}>
            <StepEvidence step={step} />
          </motion.div>
        </InView>
      </div>
    </article>
  );
}

/**
 * The walkthrough: one setup followed from first setup to day two, a step per feature. On wide
 * screens the route rail holds beside the steps, its spine filling as the page scrolls.
 */
export function Walkthrough() {
  const track = useRef<HTMLDivElement>(null);
  const active = useActiveStep(steps.map((step) => step.id));
  const at = steps.findIndex((step) => step.id === active);
  const current = steps[at];
  return (
    <section className="route" aria-label="Walkthrough">
      {/* On narrow screens, where the rail does not fit, a slip under the header names the step. */}
      <div
        className="route-progress"
        aria-hidden="true"
        data-shown={current === undefined ? "false" : "true"}
      >
        <div className="landing-shell">
          <span className="route-progress-slip">
            <span className="route-rail-number">
              {current === undefined ? "" : `${stepNumber(at)} / ${stepNumber(steps.length - 1)}`}
            </span>
            <span>{current?.title.replace(/\.$/u, "")}</span>
          </span>
        </div>
      </div>
      <div ref={track} className="landing-shell route-grid">
        <RouteRail track={track} active={active} />
        <div className="route-steps">
          {days.map((day) => (
            <div key={day.id} className="route-day">
              <InView className="route-day-head">
                <motion.h2 id={day.id} data-intro="" variants={settle(0, 14)}>
                  {day.title}
                </motion.h2>
                <motion.p data-intro="" variants={settle(0.08, 8)}>
                  {day.text}
                </motion.p>
              </InView>
              {steps.map((step, index) =>
                step.day === day.id ? (
                  <StepArticle
                    key={step.id}
                    step={step}
                    index={index}
                    active={active === step.id}
                  />
                ) : null,
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
