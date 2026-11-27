import { motion } from "motion/react";
import { features } from "./content.ts";
import { InView, settle } from "./drafting-sheet.tsx";
import { InlineCode } from "./inline-code.tsx";

/** A part's number, two digits, as the features page numbers its parts. */
const step = (index: number) => String(index + 1).padStart(2, "0");

/**
 * The features, as a strip of six parts on the blueprint sheet, under the problem they answer: each
 * part is one line and a link to its section of the features page, which has the commands, figures
 * and details.
 */
export function Features() {
  return (
    <section id="features" className="landing-section features" aria-labelledby="features-title">
      <div className="landing-shell">
        <InView className="features-head">
          <motion.p className="landing-label" data-intro="" variants={settle(0, 8)}>
            {features.label}
          </motion.p>
          <motion.h2 id="features-title" data-intro="" variants={settle(0.06, 16)}>
            {features.heading}
          </motion.h2>
          <div className="features-intro">
            <motion.p data-intro="" variants={settle(0.12, 10)}>
              {features.problem}
            </motion.p>
            <motion.p className="features-intro-next" data-intro="" variants={settle(0.2, 10)}>
              {features.intro}
            </motion.p>
          </div>
        </InView>
        <InView className="features-strip" amount={0.2}>
          <ul className="features-parts">
            {features.parts.map((part, index) => (
              <motion.li key={part.id} data-intro="" variants={settle(0.08 + index * 0.05, 10)}>
                <a href={`${features.more.href}#${part.id}`} className="features-part">
                  <span className="features-part-name">
                    <span className="features-part-step">{step(index)}</span>
                    {part.name}
                  </span>
                  <span className="features-part-line">
                    <InlineCode text={part.line} />
                  </span>
                </a>
              </motion.li>
            ))}
          </ul>
          <motion.p className="features-more" data-intro="" variants={settle(0.4, 0)}>
            <a href={features.more.href}>{features.more.label}</a>
          </motion.p>
        </InView>
      </div>
    </section>
  );
}
