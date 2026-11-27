import type { Namespace } from "../choices/choice-schema.ts";
import { sha256 } from "../identity/portable.ts";
import { compareCodeUnits } from "../identity/ordering.ts";
import { byteLength, inlinesRulesBody } from "../sources/source-rules.ts";
import type { SourceDeclaration } from "../sources/source-schema.ts";

/**
 * The registration ID of the skills Tack generates. No source has it: it marks the managed links
 * to a generated skill, whose folder is in Tack's state directory, never in a source.
 */
export const generatedSkillRegistrationId = "5c0f2a1e-7d3b-4e8a-9b6c-2f4d8e1a3c57";

/** The name of the sources skill of a project. Tack reserves it: no source skill may take it. */
export const projectSourcesSkillName = "tack-sources";

/** The name of the sources skill linked for the user. Tack reserves it too. */
export const userSourcesSkillName = "tack-user-sources";

/** The names Tack reserves for the skills it generates. */
export const reservedSkillNames: ReadonlyArray<string> = [
  ...new Set([projectSourcesSkillName, userSourcesSkillName]),
];

/** The name of the sources skill a namespace links. */
export const sourcesSkillName = (namespace: Namespace) =>
  namespace._tag === "project" ? projectSourcesSkillName : userSourcesSkillName;

/**
 * The description of every sources skill. It is fixed, whatever the sources, so it stays well
 * under the 1,024 characters that the Agent Skills format allows, and it tells an agent to load
 * the skill before it edits a linked file, which is the moment the skill matters.
 */
export const sourcesSkillDescription =
  "The Tack sources behind the skills, commands and docs linked here - what each one holds, where it lives, who maintains it and its rules for editing it. Use before editing any file in an agent's skills or commands folder (such as .claude/skills or .agents/skills) or in .tack/docs: these are links into shared Tack sources, each with its own maintainers and rules.";

/** The UTF-8 bytes the body of a sources skill keeps to, past which it shows less of each source. */
export const sourcesSkillBodyLimit = 8192;

/** What a sources skill shows about one source. */
export type SourcesSkillSource = {
  /** The source label, or its registration ID when no label names it unambiguously. */
  readonly label: string;
  readonly description?: string;
  /** The real path of the source folder, where its `tack.yaml` is. */
  readonly path: string;
  readonly maintainers: ReadonlyArray<string>;
  readonly rules?: NonNullable<SourceDeclaration["rules"]>;
};

/** Everything a sources skill is rendered from: one namespace and the sources it links. */
export type SourcesSkillInputs = {
  readonly namespace: Namespace;
  readonly sources: ReadonlyArray<SourcesSkillSource>;
};

/** How much of each source the body shows: all of it, its rules by reference, or one line. */
type Detail = "full" | "rules-by-reference" | "compact";

const declarationOf = (source: SourcesSkillSource) => `${source.path}/tack.yaml`;

/** One line of text: any run of white space, line breaks included, becomes one space. */
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

/** `text` as a Markdown block quote, so the author's headings stay inside the source's section. */
const quoted = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");

const rulesLines = (source: SourcesSkillSource, detail: Detail): ReadonlyArray<string> => {
  const { rules } = source;
  if (rules === undefined) return ["- Rules: none"];
  const when = oneLine(rules.description);
  return detail === "full" && inlinesRulesBody(rules.body)
    ? [`- Rules: ${when} The source's authors wrote them:`, "", quoted(rules.body)]
    : [
        `- Rules: ${when} Read \`rules.body\` in \`${declarationOf(source)}\`: it is too long to show here.`,
      ];
};

const sourceSection = (source: SourcesSkillSource, detail: Detail): ReadonlyArray<string> =>
  detail === "compact"
    ? [
        `- **${source.label}**: \`${source.path}\`. Rules: ${source.rules === undefined ? "none" : "read `rules.body` in its `tack.yaml`"}.`,
      ]
    : [
        `### ${source.label}`,
        "",
        source.description === undefined
          ? "No description: read the files at its path to learn what it holds."
          : oneLine(source.description),
        "",
        `- Path: \`${source.path}\``,
        `- Maintainers: ${source.maintainers.length === 0 ? "none listed" : source.maintainers.join(", ")}`,
        ...rulesLines(source, detail),
        "",
      ];

/** The hash of everything a sources skill is rendered from, as 16 hexadecimal characters. */
const inputsHash = (inputs: SourcesSkillInputs) => sha256(JSON.stringify(inputs)).slice(0, 16);

const bodyOf = (inputs: SourcesSkillInputs, detail: Detail) =>
  [
    inputs.namespace._tag === "project"
      ? `# Tack sources of project ${inputs.namespace.projectName}`
      : "# Tack sources linked for the user",
    "",
    `Tack wrote this skill at the last \`tack sync\`, from the \`tack.yaml\` of each source below. Do not edit it: the next sync rewrites it. Inputs: \`${inputsHash(inputs)}\`.`,
    "",
    "The skills and commands in the agents' folders and the docs in `.tack/docs` are links into these sources. Editing a file through a link changes the source, not this repository, and reaches everyone who links that source. Before you edit a linked file:",
    "",
    "1. Find its source: `realpath FILE` prints the real file, inside one of the paths below.",
    "2. Read that source's rules below and follow them.",
    "3. Edit the real file in the source. Never replace a link with a copy.",
    "",
    "## Sources",
    "",
    ...inputs.sources.flatMap((source) => sourceSection(source, detail)),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");

/**
 * The `SKILL.md` of a namespace's sources skill, and the hash of its inputs: a fixed frontmatter, then each source by label
 * with its description, path, maintainers and rules. It records the hash of its inputs, so the
 * same inputs always render the same text. When the body passes {@link sourcesSkillBodyLimit} it
 * points to each source's `tack.yaml` for its rules, and past that lists one line per source.
 */
export const renderSourcesSkill = (
  inputs: SourcesSkillInputs,
): { readonly text: string; readonly inputs: string } => {
  const sorted = {
    namespace: inputs.namespace,
    sources: [...inputs.sources].sort(
      (left, right) =>
        compareCodeUnits(left.label, right.label) || compareCodeUnits(left.path, right.path),
    ),
  };
  const fits = (body: string) => byteLength(body) <= sourcesSkillBodyLimit;
  const full = bodyOf(sorted, "full");
  const byReference = fits(full) ? full : bodyOf(sorted, "rules-by-reference");
  const body = fits(byReference) ? byReference : bodyOf(sorted, "compact");
  return {
    text: [
      "---",
      `name: ${sourcesSkillName(inputs.namespace)}`,
      `description: ${JSON.stringify(sourcesSkillDescription)}`,
      "---",
      "",
      body,
    ].join("\n"),
    inputs: inputsHash(sorted),
  };
};
