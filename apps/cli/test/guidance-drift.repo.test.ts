import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { describeDrift, scanGuidance } from "../../../scripts/guidance-drift.ts";
import { readContracts } from "./support/contracts.ts";

const repository = resolve(import.meta.dirname, "../../..");

const markdownUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? name === "node_modules"
        ? []
        : markdownUnder(path)
      : name.endsWith(".md")
        ? [path]
        : [];
  });

/** Every guide, skill and example document an operator or agent reads. */
const guidance = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CONTEXT.md",
  "apps/cli/README.md",
  "packages/reader/README.md",
  "packages/core/README.md",
  ...markdownUnder(join(repository, ".ai/skills")).map((path) => relative(repository, path)),
  ...markdownUnder(join(repository, "apps/cli/src/builtins")).map((path) =>
    relative(repository, path),
  ),
];

it("keeps every guide, skill and example free of the removed owner", () => {
  expect(guidance.length).toBeGreaterThan(8);
  const hits = guidance.flatMap((file) =>
    scanGuidance(file, readFileSync(join(repository, file), "utf8")),
  );
  expect(describeDrift(hits)).toBe("");
});

/** Statements that describe the retired folder-based layout as current behavior. */
const retiredLayout = [
  /(?<!former )\bkind folders?\b/i,
  /\barea declarations?\b/i,
  /\bcontext area\b/i,
  /^\s*entrypoints:/,
  /starts with an underscore[^.]*\bskipped\b/i,
  /top level; every kind folder is optional/i,
  // A `tack.yaml` declares its own folder with a `.` entry, never with `kind`.
  /^\s*kind: (?:skills|commands|docs)\b/,
  /"kind":\s*"(?:skills|commands|docs)"/,
  /\b(?:skills|commands|docs) collections?\b/i,
];

it("keeps every guide and skill free of kind folders, area declarations, the underscore rule and kind collections", () => {
  const hits = guidance.flatMap((file) =>
    readFileSync(join(repository, file), "utf8")
      .split("\n")
      .flatMap((line, index) =>
        line.startsWith("_Avoid_") || retiredLayout.every((pattern) => !pattern.test(line))
          ? []
          : [`${file}:${index + 1}: ${line.trim()}`],
      ),
  );
  expect(hits).toEqual([]);
});

it("recognizes each retired statement and allows the migration wording", () => {
  const stale = [
    "Its resources live in a kind folder at the top level.",
    "Each area declaration holds version: 1.",
    "A context area names its files.",
    "entrypoints:",
    "A folder whose name starts with an underscore is skipped, so archives stay out.",
    "kind: skills",
    '{"version":1,"name":"notes","kind":"docs"}',
    "A skills collection holds skills at its top.",
  ];
  for (const line of stale)
    expect(
      retiredLayout.some((pattern) => pattern.test(line)),
      line,
    ).toBe(true);
  expect(retiredLayout.some((pattern) => pattern.test("Found a former kind folder."))).toBe(false);
});

it("keeps command help, examples and payload schemas free of the removed owner", async () => {
  const contracts = await readContracts();
  // Pretty-print so each property and description is its own line in a failure message.
  const published = JSON.stringify(contracts, null, 1);
  expect(published.length).toBeGreaterThan(10_000);
  expect(describeDrift(scanGuidance("command contracts", published))).toBe("");
});

it("fails on a reintroduced owner mention and passes on the documented exceptions", () => {
  const reintroduced = [
    "tack pick include shared skill review --project demo",
    "Add `--owner private` to the command.",
    "Each resource has an owner.",
    "Shared resources may depend only on shared resources.",
    "Docs mount at `.tack/docs/SOURCE_ID/OWNER/NAME`.",
    "review (private)",
    "<shared|private> script <name>",
  ];
  for (const line of reintroduced)
    expect(scanGuidance("apps/cli/README.md", line), line).toHaveLength(1);
  expect(scanGuidance("apps/cli/README.md", reintroduced.join("\n"))).toHaveLength(
    reintroduced.length,
  );
  // Different senses of the word, and the words around them, stay allowed.
  for (const line of [
    "Tack's ownership evidence determines which paths it may remove.",
    "A legacy `private/` directory is not read.",
    "Changes are shared with other projects attached to that source.",
    "The count and owners without changing their success classification.",
    "_Avoid_: resource address, owner, qualified name",
  ])
    expect(scanGuidance("CONTEXT.md", line), line).toEqual([]);
  expect(scanGuidance("CONTEXT.md", "An owner is shared or private.")).toHaveLength(1);
  expect(scanGuidance("README.md", "count and owners without changing")).toHaveLength(1);
  expect(
    scanGuidance("apps/cli/src/builtins/skills/use-tack/SKILL.md", "Delete the `owner` line."),
  ).toHaveLength(1);
});

it("keeps source guidance free of personal and team resource groupings", () => {
  const retired =
    /\b(?:personal|team)[ -](?:resources?|sources?|skills?|docs)\b|\b(?:team-skills|team-docs)\b|one for the team|one for the person/i;
  const hits = guidance.flatMap((file) =>
    readFileSync(join(repository, file), "utf8")
      .split("\n")
      .flatMap((line, index) =>
        retired.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
  expect(hits).toEqual([]);
});
