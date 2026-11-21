import { motion } from "motion/react";
import { DraftingSheet, InView, settle } from "../landing/drafting-sheet.tsx";
import { InlineCode, Proof } from "../landing/inline-code.tsx";
import { Terminal } from "../terminal.tsx";
import { docsHref, Footer, getStartedHref, Header } from "../landing/landing.tsx";
import {
  groundRules,
  intro,
  keyDetails,
  lenses,
  outro,
  previewFigure,
  type Detail,
  type Lens,
} from "./content.ts";
import { lensFigures, wideFigures } from "./figures.tsx";

/** A part's number on the page, two digits, as a drafting sheet numbers its views. */
const step = (index: number) => String(index + 1).padStart(2, "0");

/** The details' delays, so they arrive one after another with shrinking gaps. */
const detailDelay = (index: number) => 0.04 + Math.min(index, 5) * 0.05;

/** The page's head: the heading, the problem, the tagline, and an index that jumps to each part. */
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
        <div className="fp-head-lines">
          <motion.p className="fp-problem" data-intro="" variants={settle(0.14, 10)}>
            {intro.problem}
          </motion.p>
          <motion.p className="landing-lead" data-intro="" variants={settle(0.2, 10)}>
            {intro.tagline}
          </motion.p>
          <motion.ul className="fp-facts" data-intro="" variants={settle(0.26, 0)}>
            {intro.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </motion.ul>
        </div>
      </InView>
      <nav aria-label={intro.indexLabel} className="fp-index-frame">
        <p className="fp-index-label">{intro.indexLabel}</p>
        <InView as="div" className="fp-index" amount={0.2}>
          {lenses.map((lens, index) => (
            <motion.a
              key={lens.id}
              href={`#${lens.id}`}
              className="fp-index-item"
              data-intro=""
              variants={settle(0.12 + index * 0.05, 10)}
            >
              <span className="fp-index-top">
                <span className="fp-step">{step(index)}</span>
                <span className="fp-index-name">{lens.name}</span>
              </span>
              <span className="fp-index-when">{lens.when}</span>
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

/** A plain list of features, in the details grid. */
function DetailList({
  details,
  label,
}: {
  readonly details: ReadonlyArray<Detail>;
  readonly label?: string;
}) {
  return (
    <ul className="fp-details" aria-label={label}>
      {details.map((detail, at) => (
        <DetailItem key={detail.title} detail={detail} index={at} />
      ))}
    </ul>
  );
}

/**
 * A part: its number and name, the claim, plain lines and the proof beside its figure, then its
 * features: the key ones in view and the rest behind "More". Figures sit on alternate sides down
 * the page, so the parts keep a rhythm; a wide figure takes the whole width under the words.
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
  const key = lens.details.slice(0, keyDetails);
  const more = lens.details.slice(keyDetails);
  const layout = wideFigures.has(lens.id) ? "wide" : index % 2 === 0 ? "start" : "end";
  return (
    <section id={lens.id} className="fp-lens" aria-labelledby={titleId}>
      <div className="landing-shell">
        <InView className="fp-lens-grid" amount={0.25}>
          <div className="fp-lens-words" data-layout={layout}>
            <motion.p className="fp-lens-label" data-intro="" variants={settle(0, 8)}>
              <span className="fp-step">{step(index)}</span>
              {lens.name}
            </motion.p>
            <motion.h2 id={titleId} data-intro="" variants={settle(0.06, 16)}>
              {lens.claim}
            </motion.h2>
            <div className="fp-lens-body">
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
          </div>
          <div className="fp-lens-figure" data-layout={layout}>
            <Figure />
          </div>
        </InView>
        <InView as="div" className="fp-details-frame" amount={0.15}>
          <DetailList details={key} label={`${lens.name}: key features`} />
          {more.length === 0 ? null : (
            <details className="fp-more">
              <summary>
                More about {lens.name.toLowerCase()} <span className="fp-count">{more.length}</span>
              </summary>
              <DetailList details={more} label={`${lens.name}: more features`} />
            </details>
          )}
        </InView>
      </div>
    </section>
  );
}

/** The rules that hold under every part, then what Tack does not do, ruled off the sheet. */
function GroundRules() {
  return (
    <section className="fp-rules" aria-labelledby="rules-title">
      <div className="landing-shell">
        <InView className="fp-rules-head" amount={0.2}>
          <div>
            <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
              {groundRules.label}
            </motion.p>
            <motion.h2 id="rules-title" data-intro="" variants={settle(0.06, 16)}>
              {groundRules.heading}
            </motion.h2>
          </div>
          <motion.div className="fp-preview" data-intro="" variants={settle(0.16, 16)}>
            <Terminal
              commands={[previewFigure.command]}
              output={previewFigure.output}
              title="~/code/app"
            />
            <p className="fp-preview-caption">{previewFigure.caption}</p>
          </motion.div>
        </InView>
        <InView as="div" className="fp-details-frame" amount={0.15}>
          <DetailList details={groundRules.rules} />
        </InView>
        <InView as="div" className="fp-limits" amount={0.3}>
          <motion.h3 data-intro="" variants={settle(0, 8)}>
            {groundRules.limitsHeading}
          </motion.h3>
          <ul>
            {groundRules.limits.map((limit, at) => (
              <motion.li key={limit.title} data-intro="" variants={settle(detailDelay(at), 8)}>
                <span className="fp-limit-mark" aria-hidden="true" />
                <strong>{limit.title}</strong> <InlineCode text={limit.text} />
              </motion.li>
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
    `## ${step(index)} · ${lens.name}: ${lens.claim}\n\nFor when: ${lens.when}\n\n${lens.lines.join(" ")}\n\n\`\`\`sh\n${lens.proof}\n\`\`\`\n\n${lens.details.map(item).join("\n")}`;
  return (
    <>
      {`# ${intro.heading}

${intro.problem} ${intro.tagline}

${intro.facts.join(" · ")}

${lenses.map(lensText).join("\n\n")}

## ${groundRules.label}: ${groundRules.heading}

${previewFigure.caption}

\`\`\`text
$ ${previewFigure.command}
${previewFigure.output}
\`\`\`

${groundRules.rules.map(item).join("\n")}

### ${groundRules.limitsHeading}

${groundRules.limits.map(item).join("\n")}

## ${outro.heading}

${outro.text} [${outro.start}](${getStartedHref}) · [${outro.docs}](${docsHref})
`}
    </>
  );
}

/** The features page: every Tack feature, in six parts, on the landing's blueprint sheet. */
export function FeaturesPage() {
  if (import.meta.env.SSG_MD === true) return <FeaturesMarkdown />;
  return (
    <div className="tack-theme-dark landing fp">
      <a href="#main" className="landing-skip">
        Skip to content
      </a>
      <Header current="features" />
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
