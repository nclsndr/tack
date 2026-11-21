import { motion } from "motion/react";
import { DraftingSheet, InView, settle } from "../landing/drafting-sheet.tsx";
import { InlineCode, Proof } from "../landing/inline-code.tsx";
import { docsHref, Footer, getStartedHref, Header } from "../landing/landing.tsx";
import { groundRules, intro, lenses, outro, type Detail, type Lens } from "./content.ts";
import { lensFigures } from "./figures.tsx";

/** A lens's number on the page, two digits, as a drafting sheet numbers its views. */
const step = (index: number) => String(index + 1).padStart(2, "0");

/** The details' delays, so they arrive one after another with shrinking gaps. */
const detailDelay = (index: number) => 0.04 + Math.min(index, 5) * 0.05;

/** The page's head: the heading, the tagline, and an index of the lenses that jumps to each. */
function PageHead() {
  return (
    <header className="landing-shell fp-head">
      <InView className="fp-head-words">
        <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
          {intro.label}
        </motion.p>
        <motion.h1 id="features-title" data-intro="" variants={settle(0.06, 16)}>
          {intro.heading}
        </motion.h1>
        <motion.p className="landing-lead" data-intro="" variants={settle(0.16, 10)}>
          {intro.tagline}
        </motion.p>
      </InView>
      <nav aria-label={intro.indexLabel}>
        <InView as="div" className="fp-index" amount={0.2}>
          {lenses.map((lens, index) => (
            <motion.a
              key={lens.id}
              href={`#${lens.id}`}
              className="fp-index-item"
              data-intro=""
              variants={settle(0.2 + index * 0.05, 10)}
            >
              <span className="fp-step">{step(index)}</span>
              <span className="fp-index-name">{lens.name}</span>
              <span className="fp-index-claim">{lens.claim}</span>
            </motion.a>
          ))}
        </InView>
      </nav>
    </header>
  );
}

/** One feature: its title, a line, and the command that shows it, when there is one. */
function DetailItem({ detail, index }: { readonly detail: Detail; readonly index: number }) {
  return (
    <motion.li className="fp-detail" data-intro="" variants={settle(detailDelay(index), 10)}>
      <h3>{detail.title}</h3>
      <p>
        <InlineCode text={detail.text} />
      </p>
      {detail.command === undefined ? null : <Proof text={detail.command} />}
    </motion.li>
  );
}

/**
 * A lens: its number and name, the claim, plain lines and the proof beside its figure, then every
 * feature under it. The figure sits on alternate sides down the page, so the lenses keep a rhythm.
 */
function LensSection({
  lens,
  index,
}: {
  readonly lens: (typeof lenses)[number];
  readonly index: number;
}) {
  const Figure = lensFigures[lens.id];
  const titleId = `${lens.id}-title`;
  return (
    <section id={lens.id} className="fp-lens" aria-labelledby={titleId}>
      <div className="landing-shell">
        <InView className="fp-lens-grid" amount={0.3}>
          <div className="fp-lens-words" data-side={index % 2 === 0 ? "start" : "end"}>
            <motion.p className="fp-lens-label" data-intro="" variants={settle(0, 8)}>
              <span className="fp-step">{step(index)}</span>
              {lens.name}
            </motion.p>
            <motion.h2 id={titleId} data-intro="" variants={settle(0.06, 16)}>
              {lens.claim}
            </motion.h2>
            {lens.lines.map((line, at) => (
              <motion.p
                key={line}
                className="fp-lens-line"
                data-intro=""
                variants={settle(0.14 + at * 0.06, 10)}
              >
                <InlineCode text={line} />
              </motion.p>
            ))}
            <motion.div data-intro="" variants={settle(0.28, 0)}>
              <Proof text={lens.proof} className="fp-proof" />
            </motion.div>
          </div>
          <div className="fp-lens-figure">
            <Figure />
          </div>
        </InView>
        <InView as="div" className="fp-details-frame" amount={0.15}>
          <ul className="fp-details" aria-label={`${lens.name}: every feature`}>
            {lens.details.map((detail, at) => (
              <DetailItem key={detail.title} detail={detail} index={at} />
            ))}
          </ul>
        </InView>
      </div>
    </section>
  );
}

/** The rules that hold under every lens, ruled off the sheet. */
function GroundRules() {
  return (
    <section className="fp-rules" aria-labelledby="rules-title">
      <div className="landing-shell">
        <InView className="fp-rules-head">
          <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
            {groundRules.label}
          </motion.p>
          <motion.h2 id="rules-title" data-intro="" variants={settle(0.06, 16)}>
            {groundRules.heading}
          </motion.h2>
        </InView>
        <InView as="div" className="fp-details-frame" amount={0.15}>
          <ul className="fp-details">
            {groundRules.rules.map((rule, at) => (
              <DetailItem key={rule.title} detail={rule} index={at} />
            ))}
          </ul>
        </InView>
      </div>
    </section>
  );
}

/** The close: the way to start and the docs. */
function Outro() {
  return (
    <section className="landing-section landing-closing" aria-labelledby="outro-title">
      <div className="landing-shell">
        <h2 id="outro-title">{outro.heading}</h2>
        <p>{outro.text}</p>
        <div className="fp-outro-actions">
          <a href={getStartedHref} className="landing-button landing-button-primary">
            {outro.start}
          </a>
          <a href={docsHref} className="landing-button">
            {outro.docs}
          </a>
        </div>
      </div>
    </section>
  );
}

/** The Markdown twin of the features page: the same copy, without layout or figures. */
function FeaturesMarkdown() {
  const item = (detail: Detail) =>
    `- **${detail.title}** ${detail.text}${detail.command === undefined ? "" : ` \`${detail.command}\``}`;
  const lensText = (lens: Lens, index: number) =>
    `## ${step(index)} · ${lens.name}: ${lens.claim}\n\n${lens.lines.join(" ")}\n\n\`\`\`sh\n${lens.proof}\n\`\`\`\n\n${lens.details.map(item).join("\n")}`;
  return (
    <>
      {`# ${intro.heading}

${intro.tagline}

${lenses.map(lensText).join("\n\n")}

## ${groundRules.label}: ${groundRules.heading}

${groundRules.rules.map(item).join("\n")}

## ${outro.heading}

${outro.text} [${outro.start}](${getStartedHref}) · [${outro.docs}](${docsHref})
`}
    </>
  );
}

/** The features page: every Tack feature, by lens, on the landing's blueprint sheet. */
export function FeaturesPage() {
  if (import.meta.env.SSG_MD === true) return <FeaturesMarkdown />;
  return (
    <div className="tack-theme-dark landing fp">
      <a href="#main" className="landing-skip">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <DraftingSheet>
          <PageHead />
          {lenses.map((lens, index) => (
            <LensSection key={lens.id} lens={lens} index={index} />
          ))}
          <GroundRules />
        </DraftingSheet>
        <Outro />
      </main>
      <Footer />
    </div>
  );
}
