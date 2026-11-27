import { agentPrompt } from "@tackup/harness/prompts/landing";
import { demoWalkthrough } from "../../demo/demo-walkthrough.ts";
import { siteUrl } from "../site.ts";
import { demo, docsHref, features, getStarted, hero, questions, story } from "./content.ts";

/** The Markdown twin of the landing page: the same copy, without layout or illustrations. */
export const landingMarkdown = () => {
  const walkthrough = demoWalkthrough.map((step) => `$ ${step.command}`).join("\n");
  const metaphor = story.beats
    .map((beat) => `- **${beat.title}** ${beat.text} \`${beat.proof}\``)
    .join("\n");
  const parts = features.parts
    .map(
      (part) => `- **[${part.name}](${siteUrl(`${features.more.href}#${part.id}`)})** ${part.line}`,
    )
    .join("\n");
  const answers = questions.map((item) => `- **${item.question}** ${item.answer}`).join("\n");
  return `# Tack: ${hero.headline}

${hero.subhead}

${hero.agents}

${hero.facts.join(" · ")}

## ${demo.heading}

${demo.agent.intro}

${demo.markdown}

\`\`\`sh
${walkthrough}
\`\`\`

## ${story.heading}

${story.intro}

${metaphor}

## ${features.heading}

${features.problem}

${features.intro}

${parts}

[${features.more.label}](${siteUrl(features.more.href)})

## Get started

Paste this prompt into your coding agent:

> ${agentPrompt}

Or run the commands yourself. ${getStarted.manualIntro}

\`\`\`sh
${getStarted.commands.join("\n")}
\`\`\`

${getStarted.note} ${getStarted.teammate}

## Questions

${answers}

Read the docs: [${siteUrl(docsHref)}](${siteUrl(docsHref)})
`;
};
