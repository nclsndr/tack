import { docsHref } from "../landing/content.ts";
import { siteUrl } from "../site.ts";
import {
  agentsFigure,
  groundRules,
  install,
  intro,
  lenses,
  previewFigure,
  profileFigure,
  projectFigure,
  scriptFigure,
  sharedAgents,
  sourceFigure,
  step,
  type Detail,
  type Lens,
  type LensId,
} from "./content.ts";

const item = (detail: Detail) =>
  `- **${detail.title}** ${detail.text}${detail.command === undefined ? "" : ` \`${detail.command}\``}`;

const shared = `### ${sharedAgents.heading}\n\n${sharedAgents.intro}\n\n| Agent | Folder | Reads it at |\n| --- | --- | --- |\n${sharedAgents.rows
  .map(
    (row) =>
      `| [${row.agent}](${row.href}) | \`${row.folder}\` | ${row.scope}${"note" in row ? `, ${row.note}` : ""} |`,
  )
  .join("\n")}`;

/**
 * The facts each part's figure draws, as text: the page shows them only as figures, and the
 * folder each agent reads is the fact an agent most needs. The docs figure is a screenshot of the
 * reader, which the part's lines already describe.
 */
const figures: Record<LensId, string> = {
  sources: `One source, \`${sourceFigure.root}\`:\n\n${sourceFigure.entries.map((entry) => `- \`${entry.path}\`: ${entry.kind}`).join("\n")}`,
  projects: `In \`${projectFigure.project}\`, every worktree gets the same link, \`${projectFigure.link}\`:\n\n${projectFigure.worktrees.map((worktree) => `- \`${worktree.root}\`: ${worktree.note}`).join("\n")}`,
  agents: `One sync links \`${agentsFigure.source}\` into each agent's folder in a project, and the command \`ship.md\` into the agents that take commands:\n\n| Agent | Skill | Command |\n| --- | --- | --- |\n${agentsFigure.links
    .map((link) => {
      const command = agentsFigure.commands.find((entry) => entry.agent === link.agent);
      return `| ${link.agent} | \`${link.path}\` | ${command === undefined ? "skills only" : `\`${command.path}\``} |`;
    })
    .join("\n")}`,
  profiles: profileFigure.steps
    .map(
      (entry, index) =>
        `${index + 1}. \`${entry.what}\`: ${entry.how}${"command" in entry ? `, with \`${entry.command}\`` : ""}`,
    )
    .join("\n"),
  docs: "",
  scripts: `\`${scriptFigure.file}\`:\n\n\`\`\`ts\n${scriptFigure.code.join("\n")}\n\`\`\``,
};

const lensText = (lens: Lens & { readonly id: LensId }, index: number) =>
  [
    `## ${step(index)} · ${lens.name}: ${lens.claim}`,
    `For when: ${lens.when}`,
    lens.lines.join(" "),
    `\`\`\`sh\n${lens.proof}\n\`\`\``,
    figures[lens.id],
    lens.details.map(item).join("\n"),
    lens.id === "agents" ? shared : "",
  ]
    .filter((block) => block !== "")
    .join("\n\n");

/** The Markdown twin of the features page: the same copy and the figures' facts, without layout. */
export const featuresMarkdown = () => `# ${intro.heading}

${intro.problem}

[${intro.limitsLink}](${siteUrl("/features#limits")})

${lenses.map(lensText).join("\n\n")}

## ${groundRules.label}: ${groundRules.heading}

${previewFigure.caption}

\`\`\`text
$ ${previewFigure.command}
${previewFigure.output}
\`\`\`

${groundRules.rules.map(item).join("\n")}

### ${groundRules.notYetHeading}

${groundRules.notYet.map(item).join("\n")}

### ${groundRules.limitsHeading}

${groundRules.limits.map(item).join("\n")}

## ${install.heading}

${install.text}

\`\`\`sh
${install.commands.join("\n")}
\`\`\`

[${install.guide}](${siteUrl(install.guideHref)}) · [${install.docs}](${siteUrl(docsHref)})
`;
