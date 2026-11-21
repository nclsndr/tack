import { motion } from "motion/react";
import { DraftingSheet, InView, settle } from "../landing/drafting-sheet.tsx";
import { InlineCode } from "../landing/inline-code.tsx";
import {
  featuresHref,
  gettingStartedHref as startHref,
  SiteFooter,
  SiteHeader,
} from "../landing/site-chrome.tsx";
import { also, closing, days, limits, opening, steps } from "./content.ts";
import { CommandChip, stepNumber, Walkthrough } from "./walkthrough.tsx";

/**
 * The opening: the label, the headline and the tagline, then the whole route at a glance, each
 * station a jump to its step.
 */
function Opening() {
  return (
    <section className="route-opening" aria-labelledby="features-page-title">
      <InView className="landing-shell route-opening-copy" amount={0.2}>
        <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
          {opening.label}
        </motion.p>
        <motion.h1 id="features-page-title" data-intro="" variants={settle(0.05, 18)}>
          {opening.title}
        </motion.h1>
        <div className="route-opening-aside">
          <motion.p className="landing-lead" data-intro="" variants={settle(0.14, 12)}>
            {opening.lead}
          </motion.p>
          <motion.p className="route-opening-intro" data-intro="" variants={settle(0.2, 10)}>
            <InlineCode text={opening.intro} />
          </motion.p>
          <motion.p className="route-opening-install" data-intro="" variants={settle(0.26, 8)}>
            {opening.install.text} <a href={opening.install.href}>{opening.install.link}</a>.
          </motion.p>
        </div>
      </InView>
      <InView className="landing-shell" amount={0.2}>
        <nav className="route-map" aria-label="The route">
          {days.map((day, dayIndex) => (
            <motion.div
              key={day.id}
              className="route-map-day"
              data-intro=""
              variants={settle(0.24 + dayIndex * 0.1, 10)}
            >
              <a href={`#${day.id}`} className="route-map-label">
                {day.title}
              </a>
              <ol>
                {steps.map((step, index) =>
                  step.day === day.id ? (
                    <li key={step.id}>
                      <a href={`#${step.id}`}>
                        <span className="links-mark" aria-hidden="true" />
                        <span className="route-map-number">{stepNumber(index)}</span>
                        <span className="route-map-title">{step.title.replace(/\.$/u, "")}</span>
                      </a>
                    </li>
                  ) : null,
                )}
              </ol>
            </motion.div>
          ))}
        </nav>
      </InView>
    </section>
  );
}

/** The rest of Tack, then what it leaves to you. */
function Beyond() {
  return (
    <section className="route-beyond" aria-labelledby="also-title">
      <div className="landing-shell">
        <InView className="also route-also" amount={0.2}>
          <motion.h2
            id="also-title"
            className="route-beyond-heading"
            data-intro=""
            variants={settle(0, 12)}
          >
            {also.heading}
          </motion.h2>
          <div className="also-items">
            {also.items.map((item, index) => (
              <motion.article
                key={item.title}
                className="also-item"
                data-intro=""
                variants={settle(0.04 + (index % 3) * 0.05, 10)}
              >
                <h3>{item.title}</h3>
                <p>
                  <InlineCode text={item.text} />
                </p>
                <CommandChip text={item.proof} />
              </motion.article>
            ))}
          </div>
        </InView>
        <InView className="route-limits" amount={0.3}>
          <motion.h2 className="route-beyond-heading" data-intro="" variants={settle(0, 12)}>
            {limits.heading}
          </motion.h2>
          <ul>
            {limits.items.map((item, index) => (
              <motion.li key={item} data-intro="" variants={settle(0.06 + index * 0.04, 8)}>
                <InlineCode text={item} />
              </motion.li>
            ))}
          </ul>
        </InView>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="landing-section landing-closing" aria-labelledby="closing-title">
      <div className="landing-shell">
        <h2 id="closing-title">{closing.heading}</h2>
        <p>{closing.text}</p>
        <div className="landing-actions route-closing-actions">
          <a href={startHref} className="landing-button landing-button-primary">
            {closing.start}
          </a>
          <a href="/#demo" className="landing-button">
            {closing.demo}
          </a>
        </div>
      </div>
    </section>
  );
}

/** The Markdown twin of the features page: the same steps and commands, without layout. */
function FeaturesMarkdown() {
  const step = (item: (typeof steps)[number], index: number) => {
    const output =
      item.output === undefined
        ? ""
        : `\n\n\`\`\`text\n$ ${item.output.command}\n${item.output.text}\n\`\`\`${item.output.cut === undefined ? "" : `\n\n${item.output.cut}`}`;
    const code =
      item.code === undefined
        ? ""
        : `\n\n\`${item.code.file}\`:\n\n\`\`\`${item.code.file.slice(item.code.file.lastIndexOf(".") + 1)}\n${item.code.text}\n\`\`\``;
    const elsewhere =
      item.elsewhere === undefined
        ? ""
        : `\n\n${item.elsewhere.label}:\n\n\`\`\`sh\n${item.elsewhere.run.join("\n")}\n\`\`\``;
    const or = `${elsewhere}${item.or === undefined ? "" : `\n\n${item.or}`}`;
    return `### ${stepNumber(index)}. ${item.title}

${item.summary}

You run:

\`\`\`sh
${item.run.join("\n")}
\`\`\`${or}

Tack does:

${item.tack.map((fact) => `- ${fact}`).join("\n")}${output}${code}`;
  };
  const walkthrough = days
    .map(
      (day) =>
        `## ${day.title}\n\n${day.text}\n\n${steps
          .map((item, index) => (item.day === day.id ? step(item, index) : ""))
          .filter((text) => text !== "")
          .join("\n\n")}`,
    )
    .join("\n\n");
  return (
    <>
      {`# Tack features: ${opening.title}

${opening.lead}

${opening.intro}

${opening.install.text} [${opening.install.link}](${opening.install.href}).

${walkthrough}

## ${also.heading}

${also.items.map((item) => `- **${item.title}** ${item.text} \`${item.proof}\``).join("\n")}

## ${limits.heading}

${limits.items.map((item) => `- ${item}`).join("\n")}

Get started: [${startHref}](${startHref}) · The landing page: [/](/) · This page: [${featuresHref}](${featuresHref})
`}
    </>
  );
}

/**
 * The features page: one setup followed through Tack, from first setup to day two, on the landing
 * page's blueprint sheet and in its header. It is always dark, like the landing page.
 */
export function FeaturesPage() {
  if (import.meta.env.SSG_MD === true) return <FeaturesMarkdown />;
  return (
    <div className="tack-theme-dark landing route-page">
      <a href="#main" className="landing-skip">
        Skip to content
      </a>
      <SiteHeader page="features" />
      <main id="main">
        <DraftingSheet>
          <Opening />
          <Walkthrough />
          <Beyond />
        </DraftingSheet>
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}
