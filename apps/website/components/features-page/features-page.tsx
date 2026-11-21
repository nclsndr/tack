import { motion, useReducedMotion } from "motion/react";
import { Fragment } from "react";
import { DraftingSheet, InView, settle } from "../landing/drafting-sheet.tsx";
import { IntroFallback } from "../landing/hero-intro.tsx";
import { InlineCode } from "../landing/inline-code.tsx";
import { Footer, Header } from "../landing/landing.tsx";
import { docsHref, getStartedHref } from "../landing/routes.ts";
import { Terminal } from "../terminal.tsx";
import {
  catalogue,
  featuresPage,
  modes,
  type Capability,
  type CapabilityGroup,
} from "./catalogue.ts";

/** The page's opening: what the page holds, the tagline, and the way to start. */
function Opening() {
  return (
    <InView className="catalogue-opening landing-shell">
      <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
        {featuresPage.label}
      </motion.p>
      <motion.h1 id="features-page-title" data-intro="" variants={settle(0.06, 16)}>
        {featuresPage.headline}
      </motion.h1>
      <motion.p className="landing-lead" data-intro="" variants={settle(0.14, 10)}>
        {featuresPage.lead}
      </motion.p>
      <motion.p className="catalogue-intro" data-intro="" variants={settle(0.2, 8)}>
        {featuresPage.intro}
      </motion.p>
      <motion.div className="landing-actions" data-intro="" variants={settle(0.26, 0)}>
        <a href={getStartedHref} className="landing-button landing-button-primary">
          Get started
        </a>
        <a href={docsHref} className="landing-button">
          Read the docs
        </a>
      </motion.div>
    </InView>
  );
}

/** The catalogue's index: every group with the capabilities it holds, each a link to its card. */
function Index() {
  return (
    <nav aria-label="Features" className="catalogue-index landing-shell">
      <ol>
        {catalogue.map((group) => (
          <li key={group.id}>
            <a href={`#${group.id}`} className="catalogue-index-group">
              {group.label}
            </a>
            <ul>
              {group.capabilities.map((capability) => (
                <li key={capability.id}>
                  <a href={`#${capability.id}`}>{capability.title}</a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <Legend />
    </nav>
  );
}

/** How a card's command behaves, in the CLI's word, with the CLI's meaning on hover. */
function ModeTag({ mode }: { readonly mode: Capability["mode"] }) {
  if (mode === undefined) return <span className="capability-mode">shell</span>;
  return (
    <span className="capability-mode" data-mode={mode} title={modes[mode].meaning}>
      {modes[mode].label}
    </span>
  );
}

/**
 * One capability: its benefit, how the command behaves, and what the command really printed. It
 * settles in as it scrolls into view; the second card of a row a beat after the first.
 */
function CapabilityCard({
  capability,
  index,
}: {
  readonly capability: Capability;
  readonly index: number;
}) {
  const still = useReducedMotion() === true;
  return (
    <motion.article
      id={capability.id}
      className="capability"
      aria-labelledby={`${capability.id}-title`}
      data-intro=""
      initial={still ? "here" : "away"}
      whileInView="here"
      viewport={{ once: true, amount: 0.15 }}
      variants={settle(0.08 * (index % 2), 16)}
    >
      <header className="capability-head">
        <h3 id={`${capability.id}-title`}>{capability.title}</h3>
        <ModeTag mode={capability.mode} />
      </header>
      <p className="capability-benefit">
        <InlineCode text={capability.benefit} />
      </p>
      <Terminal commands={[capability.command]} output={capability.output} title={capability.cwd} />
    </motion.article>
  );
}

/** The modes a card can name, with their meanings, as the legend of `tack --help` gives them. */
function Legend() {
  return (
    <div className="catalogue-legend">
      <p>
        <InlineCode text={featuresPage.legend} />
      </p>
      <dl>
        {Object.entries(modes).map(([mode, { label, meaning }]) => (
          <div key={mode}>
            <dt>
              <span className="capability-mode" data-mode={mode}>
                {label}
              </span>
            </dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One group of the catalogue: its heading, then its capabilities as a grid of cards. */
function Group({ group }: { readonly group: CapabilityGroup }) {
  return (
    <section id={group.id} className="catalogue-group" aria-labelledby={`${group.id}-title`}>
      <div className="landing-shell">
        <InView className="catalogue-group-head" amount={0.6}>
          <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
            {group.label}
          </motion.p>
          <motion.h2 id={`${group.id}-title`} data-intro="" variants={settle(0.06, 14)}>
            {group.heading}
          </motion.h2>
          <motion.p className="catalogue-group-intro" data-intro="" variants={settle(0.12, 8)}>
            <InlineCode text={group.intro} />
          </motion.p>
        </InView>
        <div className="capability-grid">
          {group.capabilities.map((capability, index) => (
            <CapabilityCard key={capability.id} capability={capability} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** The close: one step from here to a working setup. */
function Closing() {
  return (
    <section className="landing-section landing-closing" aria-labelledby="catalogue-closing-title">
      <div className="landing-shell">
        <h2 id="catalogue-closing-title">{featuresPage.closing.heading}</h2>
        <p>{featuresPage.closing.text}</p>
        <a href={getStartedHref} className="landing-button landing-button-primary">
          Get started
        </a>
      </div>
    </section>
  );
}

/** The Markdown twin: the same catalogue as headings, benefits and plain command output. */
function FeaturesMarkdown() {
  return (
    <>
      {`# ${featuresPage.headline}\n\n${featuresPage.lead}\n\n${featuresPage.intro}\n`}
      {catalogue.map((group) => (
        <Fragment key={group.id}>
          {`\n## ${group.heading}\n\n${group.intro}\n`}
          {group.capabilities.map((capability) => (
            <Fragment key={capability.id}>
              {`\n### ${capability.title}\n\n${capability.benefit}${capability.mode === undefined ? "" : ` Mode: ${capability.mode}, ${modes[capability.mode].meaning}.`}\n`}
              <Terminal commands={[capability.command]} output={capability.output} />
            </Fragment>
          ))}
        </Fragment>
      ))}
      {`\n## ${featuresPage.closing.heading}\n\n${featuresPage.closing.text} [Get started](${getStartedHref})\n`}
    </>
  );
}

/**
 * The features page: a catalogue of every capability on the landing page's blueprint sheet. Each
 * card pairs a one-line benefit with the real output of the command that delivers it.
 */
export function FeaturesPage() {
  if (import.meta.env.SSG_MD === true) return <FeaturesMarkdown />;
  return (
    <div className="tack-theme-dark landing catalogue-page">
      <IntroFallback />
      <a href="#main" className="landing-skip">
        Skip to content
      </a>
      <Header current="features" />
      <main id="main" aria-labelledby="features-page-title">
        <DraftingSheet>
          <Opening />
          <Index />
          {catalogue.map((group) => (
            <Group key={group.id} group={group} />
          ))}
        </DraftingSheet>
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
