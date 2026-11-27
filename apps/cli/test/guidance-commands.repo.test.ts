import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { describeDrift, scanCodes, scanCommands } from "../../../scripts/guidance-drift.ts";
import { agentAdapterDescriptors } from "../src/domain/agents/agent-adapter.ts";
import { CatalogQuarantineReasonSchema } from "../src/domain/sources/catalog-schema.ts";
import { DeclarationSchema, decodeSourceDeclaration } from "../src/domain/sources/source-schema.ts";
import {
  parseResourceMetadata,
  parseSkillDocument,
} from "../src/features/sources/resource-frontmatter.ts";
import { declaredPathSyntaxIssue } from "../src/features/sources/declared-path.ts";
import { docsEntrySchema } from "../src/features/sources/docs-discovery.ts";
import { Effect, Schema } from "effect";
import { readContracts } from "./support/contracts.ts";
import { decodeEntry, declarationKinds } from "../src/features/sources/resource-declarations.ts";

const repository = resolve(import.meta.dirname, "../../..");

const filesUnder = (directory: string, suffix: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? filesUnder(path, suffix)
      : name.endsWith(suffix)
        ? [path]
        : [];
  });

const read = (file: string) => readFileSync(join(repository, file), "utf8");

/** The built-in skills the release ships. */
const skills = filesUnder(join(repository, "apps/cli/src/builtins"), ".md").map((path) =>
  relative(repository, path),
);

/** The reference pages of the docs site, where the operator and author documentation lives. */
const referencePages = filesUnder(join(repository, "apps/website/docs/docs/reference"), ".mdx").map(
  (path) => relative(repository, path),
);

const { commands: published } = await readContracts();

it("keeps every command and flag a skill names in the executable's own contracts", () => {
  expect(skills.length).toBeGreaterThanOrEqual(4);
  const hits = skills.flatMap((file) => scanCommands(file, read(file), published));
  expect(describeDrift(hits)).toBe("");
});

it("keeps every command and flag the contributor and agent guides name in the executable's contracts", () => {
  const guides = ["AGENTS.md", "CONTRIBUTING.md"];
  const hits = guides.flatMap((file) => scanCommands(file, read(file), published));
  expect(describeDrift(hits)).toBe("");
});

it("recognizes unknown commands and flags, list aliases and placeholders", () => {
  const scan = (text: string) => scanCommands("skill.md", text, published).map(({ rule }) => rule);
  expect(scan("Run `tack --json sync --project demo --apply`.")).toEqual([]);
  expect(scan("Run `tack --json sync --nope`.")).toEqual(["flag-unknown"]);
  expect(scan("Run `tack --json frobnicate`.")).toEqual(["command-unknown"]);
  expect(scan("```sh\nbun tack --json docs search QUERY --limit 5 --bogus\n```")).toEqual([
    "flag-unknown",
  ]);
  expect(scan("Use `<executable> --json upgrade status`, `tack --json PATH... --help`.")).toEqual(
    [],
  );
  expect(scan("Inspect `source list` and `tack --json pick ls`.")).toEqual([]);
  expect(scan("Read `sync --include-optional` and `explore --user`.")).toEqual([]);
  expect(scan("Read `catalog --no-such-flag`.")).toEqual(["flag-unknown"]);
  expect(scan("Run `tack script run report --user -- --repo x --no-such-flag`.")).toEqual([]);
  expect(scan("Run `tack docs check` and `docs frobnicate --project demo`.")).toEqual([
    "command-unknown",
    "command-unknown",
  ]);
  expect(scan("Run `tack docs icons database` and `tack check FILE`.")).toEqual([]);
});

/**
 * Diagnostic codes are string literals in the executable's source, never computed. The reader is
 * part of the executable and defines the issue codes of `tack docs search`.
 */
const codeCorpus = ["apps/cli/src", "packages/reader/src"]
  .flatMap((directory) => filesUnder(join(repository, directory), ".ts"))
  .filter((path) => path.endsWith(".test.ts") === false)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

it("keeps every diagnostic code a skill or reference page names defined by the executable", () => {
  const known = (code: string) => codeCorpus.includes(`"${code}"`);
  const hits = [...skills, ...referencePages].flatMap((file) => scanCodes(file, read(file), known));
  expect(describeDrift(hits)).toBe("");
  expect(
    scanCodes("skill.md", "Fix `declaration-path-gone` and `declaration-path-missing`.", known),
  ).toEqual([{ file: "skill.md", line: 1, text: "declaration-path-gone", rule: "code-unknown" }]);
  expect(scanCodes("skill.md", "Use `opt-in` and `user-activation`.", known)).toEqual([]);
});

it("keeps the stable JSON paragraph in step with the commands that publish payload schemas", () => {
  // The skills tell agents which commands have a stable, schema-backed payload. When this set
  // changes, update `use-tack` and its operations reference.
  const stable = published
    .filter((contract) =>
      contract.responses.some((response) =>
        Object.values(response.slots).some((slot) => slot !== "json"),
      ),
    )
    .map((contract) => contract.commandPath.join(" "))
    .toSorted();
  expect(stable).toEqual(["doctor", "init", "status", "sync", "upgrade", "upgrade status"]);
  for (const file of ["apps/cli/src/builtins/skills/use-tack/SKILL.md"]) {
    const text = read(file);
    for (const name of ["status", "sync", "init", "doctor", "upgrade", "--version"])
      expect(text, `${file} names ${name} as stable`).toContain(`\`${name}\``);
  }
});

it("documents the adapter table in the operations reference row for row", () => {
  const operations = read("apps/cli/src/builtins/skills/use-tack/references/operations.md");
  const lines = operations.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| Adapter "));
  const rows = lines.slice(header + 2);
  const documented = rows
    .slice(
      0,
      rows.findIndex((line) => line.startsWith("|") === false),
    )
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const directory = (segments: ReadonlyArray<string>, prefix: string) =>
    `\`${prefix}${segments.join("/")}\``;
  const commands = (segments: ReadonlyArray<string> | undefined, prefix: string) =>
    segments === undefined ? "not delivered" : `\`${prefix}${segments.join("/")}/NAME.md\``;
  const coded = agentAdapterDescriptors.map((adapter) => [
    `\`${adapter.id}\``,
    directory(adapter.userSkillDirectory, "~/"),
    commands(adapter.userCommandDirectory, "~/"),
    directory(adapter.projectSkillDirectory, ""),
    commands(adapter.projectCommandDirectory, ""),
  ]);
  expect(documented).toEqual(coded);
});

it("documents every source declaration key and declaration quarantine code", () => {
  const guide = [
    "apps/cli/src/builtins/skills/manage-tack-sources/SKILL.md",
    "apps/cli/src/builtins/skills/manage-tack-sources/references/tack-yaml.md",
  ]
    .map(read)
    .join("\n");
  for (const key of [...Object.keys(DeclarationSchema.fields), "reader"])
    expect(
      guide.includes(`\`${key}\``) || guide.includes(`\`${key}:`),
      `manage-tack-sources names the ${key} key`,
    ).toBe(true);
  expect(guide.includes("path: ."), "manage-tack-sources shows a . entry").toBe(true);
  const codes = CatalogQuarantineReasonSchema.literals.filter((code) =>
    code.startsWith("declaration-"),
  );
  expect(codes.length).toBeGreaterThanOrEqual(7);
  for (const code of [...codes, "resource-boundary-violation"])
    expect(
      guide.includes(`\`${code}\``) ||
        guide.includes(`\`${code.startsWith("declaration-path-") ? "declaration-path-*" : code}\``),
      `manage-tack-sources covers ${code}`,
    ).toBe(true);
});

/** The `tack.yaml` examples in a text: fenced YAML blocks that open with `version: 1`. */
/** The fenced declarations in `text`: YAML for a `tack.yaml`, JSON for a `source add --config`. */
const declarationExamples = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/```(?:ya?ml|json)\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .filter(
      (block) => block.startsWith("version: 1\n") || /^\{\s*"version": 1,\s*"name":/.test(block),
    );

it("keeps every tack.yaml example in the guidance a valid declaration", () => {
  const files = [
    "README.md",
    "CONTEXT.md",
    ...referencePages,
    ...filesUnder(join(repository, ".ai/skills"), ".md").map((path) => relative(repository, path)),
    ...skills,
  ].filter((file, index, all) => all.indexOf(file) === index);
  const examples = files.flatMap((file) =>
    declarationExamples(read(file)).map((example) => ({ file, example })),
  );
  const workedExample =
    "apps/cli/src/builtins/skills/manage-tack-sources/references/worked-source.md";
  expect(examples.filter(({ file }) => file === workedExample).length).toBeGreaterThanOrEqual(3);
  // The declaration skill and the website's source and docs references hold several; finding fewer
  // means the extractor stopped matching.
  expect(examples.length).toBeGreaterThanOrEqual(4);
  for (const { file, example } of examples) {
    const parsed: unknown = Bun.YAML.parse(example);
    const declaration = Effect.runSync(decodeSourceDeclaration(parsed));
    for (const { key, kind } of declarationKinds) {
      const entries: unknown = declaration[key] ?? [];
      if (Array.isArray(entries) === false) throw new Error(`${file}: ${key} is not a list`);
      for (const entry of entries) {
        const decoded = Effect.runSync(decodeEntry(kind, entry));
        expect("error" in decoded ? decoded.error : undefined, `${file}: ${key} entry`).toBe(
          undefined,
        );
        const path = typeof entry === "object" && entry !== null ? Reflect.get(entry, "path") : "";
        expect(declaredPathSyntaxIssue(String(path)), `${file}: ${key} path ${path}`).toBe(
          undefined,
        );
      }
    }
    const docs: unknown = declaration.docs ?? [];
    if (Array.isArray(docs) === false) throw new Error(`${file}: docs is not a list`);
    for (const entry of docs) {
      const decoded = Schema.decodeUnknownSync(docsEntrySchema, { onExcessProperty: "error" })(
        entry,
      );
      expect(declaredPathSyntaxIssue(decoded.path), `${file}: docs path`).toBe(undefined);
    }
  }
  // A key or entry this feature does not have is refused, so the check can fail.
  expect(() => Effect.runSync(decodeSourceDeclaration({ version: 1, folders: [] }))).toThrow();
  expect("error" in Effect.runSync(decodeEntry("skill", { path: "skills", glob: "*" }))).toBe(true);
});

it("decodes every worked skill frontmatter example through the resource parser", () => {
  const files = [...referencePages, ...skills];
  const examples = files.flatMap((file) =>
    [...read(file).matchAll(/```(?:markdown|yaml)\n(---\n[\s\S]*?)```/g)].map((match) => ({
      file,
      encoded: match[1] ?? "",
    })),
  );
  expect(examples.length).toBeGreaterThanOrEqual(2);
  for (const { file, encoded } of examples) {
    const closing = encoded.indexOf("\n---", 4);
    const frontmatter = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
      Bun.YAML.parse(encoded.slice(4, closing)),
    );
    expect(
      () => Effect.runSync(parseSkillDocument({ directoryName: frontmatter.name, encoded })),
      file,
    ).not.toThrow();
  }
});

it("decodes standalone metadata examples through the resource parser", () => {
  const examples = skills.flatMap((file) =>
    [...read(file).matchAll(/```yaml\n(metadata:[\s\S]*?)```/g)].map((match) => ({
      file,
      encoded: match[1] ?? "",
    })),
  );
  expect(examples.length).toBeGreaterThanOrEqual(1);
  for (const { file, encoded } of examples) {
    const frontmatter = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.Unknown }))(
      Bun.YAML.parse(encoded),
    );
    expect(() => Effect.runSync(parseResourceMetadata(frontmatter)), file).not.toThrow();
  }
});
