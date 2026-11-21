import { motion, useReducedMotion } from "motion/react";
import { Fragment } from "react";
import { DraftingSheet, InView, settle } from "../landing/drafting-sheet.tsx";
import { IntroFallback } from "../landing/hero-intro.tsx";
import { InlineCode, Proof } from "../landing/inline-code.tsx";
import { Footer, Header } from "../landing/landing.tsx";
import { docsHref, getStartedHref } from "../landing/routes.ts";
import { Terminal } from "../terminal.tsx";
import {
  alsoInTack,
  catalogue,
  featuresPage,
  modes,
  shellMode,
  type Capability,
  type CapabilityGroup,
} from "./catalogue.ts";

/** The cards a first-time reader should open first, in reading order. */
const startCards = catalogue
  .flatMap((group) => group.capabilities)
  .flatMap((capability) =>
    capability.start === undefined ? [] : [{ id: capability.id, name: capability.start }],
  );

/**
 * The page's opening: what the page holds, the tagline and the way to start; beside it, the three
 * words the page builds on and the cards to read first.
 */
function Opening() {
  return (
    <InView className="catalogue-opening landing-shell">
      <div className="catalogue-opening-words">
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
      </div>
      <motion.aside
        className="catalogue-primer"
        aria-label="Before you read"
        data-intro=""
        variants={settle(0.3, 12)}
      >
        <dl>
          {featuresPage.terms.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.definition}</dd>
            </div>
          ))}
        </dl>
        <p className="catalogue-primer-heading">{featuresPage.startHeading}</p>
        <ol>
          {startCards.map((card) => (
            <li key={card.id}>
              <a href={`#${card.id}`}>{card.name}</a>
            </li>
          ))}
        </ol>
      </motion.aside>
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

/** How a card's command behaves, in plain words, with the CLI's own wording on hover. */
function ModeTag({ mode }: { readonly mode: Capability["mode"] }) {
  const { label, meaning } = mode === undefined ? shellMode : modes[mode];
  return (
    <span className="capability-mode" data-mode={mode ?? "shell"} title={meaning}>
      {label}
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
        <span className="capability-tags">
          {capability.start === undefined ? null : (
            <span className="capability-start">{featuresPage.startHeading}</span>
          )}
          <ModeTag mode={capability.mode} />
        </span>
      </header>
      <p className="capability-benefit">
        <InlineCode text={capability.benefit} />
      </p>
      <Terminal commands={[capability.command]} output={capability.output} title={capability.cwd} />
    </motion.article>
  );
}

/**
 * The tags a card can show, each with the mode `tack --help` names and its meaning there, and the
 * tag for a plain shell command.
 */
function Legend() {
  return (
    <div className="catalogue-legend">
      <p>
        <InlineCode text={featuresPage.legend} />
      </p>
      <dl>
        {Object.entries(modes).map(([mode, { label, plain }]) => (
          <div key={mode}>
            <dt>
              <span className="capability-mode" data-mode={mode}>
                {label}
              </span>
            </dt>
            <dd>
              <code className="catalogue-legend-cli">{mode}</code> <InlineCode text={plain} />
            </dd>
          </div>
        ))}
        <div>
          <dt>
            <span className="capability-mode" data-mode="shell">
              {shellMode.label}
            </span>
          </dt>
          <dd>{shellMode.plain}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The smaller capabilities, one line and one command each, as the landing's "Also" row draws them. */
function AlsoRow() {
  return (
    <section className="catalogue-also" aria-labelledby="also-title">
      <InView className="landing-shell also" amount={0.4}>
        <motion.h2 id="also-title" className="also-heading" data-intro="" variants={settle(0, 0)}>
          {alsoInTack.heading}
        </motion.h2>
        <div className="also-items">
          {alsoInTack.items.map((item, index) => (
            <motion.article
              key={item.operation}
              className="also-item"
              data-intro=""
              variants={settle(0.04 + 0.05 * index, 10)}
            >
              <h3>{item.title}</h3>
              <p>
                <InlineCode text={item.text} />
              </p>
              <Proof text={item.command} />
            </motion.article>
          ))}
        </div>
      </InView>
    </section>
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
        <p className="catalogue-closing-note">{featuresPage.closing.note}</p>
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
      {`# ${featuresPage.headline}\n\n${featuresPage.lead}\n\n${featuresPage.intro}\n\n${featuresPage.terms.map((entry) => `- **${entry.term}**: ${entry.definition}`).join("\n")}\n`}
      {catalogue.map((group) => (
        <Fragment key={group.id}>
          {`\n## ${group.heading}\n\n${group.intro}\n`}
          {group.capabilities.map((capability) => (
            <Fragment key={capability.id}>
              {`\n### ${capability.title}\n\n${capability.benefit}${capability.mode === undefined ? "" : ` Mode: ${capability.mode}, ${modes[capability.mode].plain}`}\n`}
              <Terminal commands={[capability.command]} output={capability.output} />
            </Fragment>
          ))}
        </Fragment>
      ))}
      {`\n## ${alsoInTack.heading}\n\n${alsoInTack.items.map((item) => `- **${item.title}** ${item.text} \`${item.command}\``).join("\n")}\n`}
      {`\n## ${featuresPage.closing.heading}\n\n${featuresPage.closing.text} ${featuresPage.closing.note} [Get started](${getStartedHref})\n`}
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
          <AlsoRow />
        </DraftingSheet>
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
