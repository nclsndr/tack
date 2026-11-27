import { Effect, FileSystem, Path } from "effect";

/** How a {@link skillText} differs from the default: `<name> skill`, no metadata, a heading body. */
export type SkillTextOptions = {
  /** The `description`; `<name> skill` when absent. */
  readonly description?: string;
  /** Lines of `metadata.tack` after its `version: 1`; no metadata when absent. */
  readonly tack?: ReadonlyArray<string>;
  /** Raw frontmatter after the metadata, each line ending in a newline. */
  readonly frontmatter?: string;
  /** The text after the frontmatter; a `# <name>` heading when absent. */
  readonly body?: string;
};

/** A `metadata.tack` block of version 1 followed by the given lines, ready for a frontmatter. */
export const tackMetadata = (...lines: ReadonlyArray<string>) =>
  `metadata:\n  tack: |\n    version: 1\n${lines.map((line) => `    ${line}\n`).join("")}`;

/** The text of a valid skill named `name`. */
export const skillText = (name: string, options: SkillTextOptions = {}) =>
  [
    "---\n",
    `name: ${name}\n`,
    `description: ${options.description ?? `${name} skill`}\n`,
    options.tack === undefined ? "" : tackMetadata(...options.tack),
    options.frontmatter ?? "",
    "---\n",
    options.body ?? `# ${name}\n`,
  ].join("");

/** The text of a bare skill: its name as description and nothing after the frontmatter. */
export const bareSkillText = (name: string, options: SkillTextOptions = {}) =>
  skillText(name, { description: name, body: "", ...options });

/** A version-1 declaration of the source `name`, followed by the given lines. */
export const declare = (name: string, ...lines: ReadonlyArray<string>) =>
  ["version: 1", `name: ${name}`, ...lines, ""].join("\n");

/** Writes `content` to `file`, creating its parent directories, and returns the file path. */
export const write = Effect.fnUntraced(function* (file: string, content: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, content);
  return file;
});

/** A {@link write} of paths relative to `root`. */
export const writeUnder = (root: string) => (relative: string, content: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* write(path.join(root, relative), content);
  });

/** Writes every file of `files`, keyed by its path relative to `root`, and returns `root`. */
export const seedSource = Effect.fnUntraced(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const writeFile = writeUnder(root);
  for (const [relative, content] of Object.entries(files)) yield* writeFile(relative, content);
  return root;
});

/**
 * The files of the standard profile source `tools`: skills under `skills`, the skill `review`, and
 * the profile `ci` at `ci.yaml` whose one member is `review`. Entries of `overrides` replace or add.
 */
export const profileSourceFiles = (
  overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  "tack.yaml":
    "version: 1\nname: tools\nskills: [{path: skills}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
  "ci.yaml": "version: 1\nname: ci\nmembers: [review]\n",
  "skills/review/SKILL.md": bareSkillText("review", { description: "Review" }),
  ...overrides,
});
