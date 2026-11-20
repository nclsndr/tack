import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  filesDigest,
  type ImportRecord,
  type ImportRecordFile,
} from "../../domain/imports/import-record.ts";
import {
  editImportsSection,
  importsSectionComment,
  readImportsSection,
  type ImportsSectionError,
} from "./imports-section.ts";

const revision = "ab12".repeat(10);
const tree = "cd34".repeat(10);
const sha = "ef56".repeat(16);

const record = (
  path: string,
  overrides: Partial<ImportRecord> = {},
  files: ReadonlyArray<ImportRecordFile> = [
    { path: "SKILL.md", sha256: sha, executable: false },
    { path: "scripts/fill.py", sha256: sha, executable: true },
  ],
): ImportRecord => ({
  path,
  location: "github:anthropics/skills",
  transport: "https",
  "ref-kind": "default",
  revision,
  "upstream-path": "skills/pdf",
  "upstream-tree": tree,
  "imported-at": "2026-11-11T12:40:00Z",
  digest: filesDigest(files),
  files,
  ...overrides,
});

const block = (path: string, eol = "\n") =>
  [
    `  - path: ${path}`,
    "    location: github:anthropics/skills",
    "    transport: https",
    "    ref-kind: default",
    `    revision: ${revision}`,
    "    upstream-path: skills/pdf",
    `    upstream-tree: ${tree}`,
    "    imported-at: 2026-11-11T12:40:00Z",
    `    digest: ${filesDigest(record(path).files)}`,
    "    files:",
    `      - { path: SKILL.md, sha256: ${sha}, executable: false }`,
    `      - { path: scripts/fill.py, sha256: ${sha}, executable: true }`,
  ]
    .map((line) => `${line}${eol}`)
    .join("");

const section = (paths: ReadonlyArray<string>, eol = "\n") =>
  `${importsSectionComment}${eol}imports:${eol}${paths.map((path) => block(path, eol)).join("")}`;

const edit = (text: string, records: ReadonlyArray<ImportRecord>) => {
  const result = editImportsSection(text, records);
  if (Result.isFailure(result))
    throw new Error(`${result.failure.line}: ${result.failure.message}`);
  return result.success;
};

const refusal = (result: Result.Result<unknown, ImportsSectionError>) => {
  if (Result.isSuccess(result)) throw new Error("expected a refusal");
  return result.failure;
};

describe("readImportsSection", () => {
  it("reads no records and no span from a file without the key", () => {
    expect(readImportsSection("version: 1\n")).toEqual(Result.succeed({ records: [] }));
  });

  it("reads records and the span written by Tack", () => {
    const text = `version: 1\nname: personal-brain\n\n${section(["skills/pdf"])}\ndepends-on:\n  - acme\n`;
    const result = readImportsSection(text);
    expect(result).toEqual(
      Result.succeed({
        records: [record("skills/pdf")],
        span: { startLine: 4, keyLine: 5, endLine: 17 },
      }),
    );
  });

  it("treats an empty key as no records but keeps its span", () => {
    expect(readImportsSection("version: 1\nimports:\n")).toEqual(
      Result.succeed({ records: [], span: { startLine: 2, keyLine: 2, endLine: 2 } }),
    );
  });

  it("accepts column-0 list items and a trailing comment on the key", () => {
    const dedented = block("skills/pdf")
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n");
    const text = `version: 1\nimports: # mine\n${dedented}`;
    expect(readImportsSection(text)).toEqual(
      Result.succeed({
        records: [record("skills/pdf")],
        span: { startLine: 2, keyLine: 2, endLine: 14 },
      }),
    );
  });

  it("refuses flow style with its line number", () => {
    const refused = refusal(readImportsSection("version: 1\nimports: []\nname: personal-brain\n"));
    expect(refused.line).toBe(2);
    expect(refused.message).toContain("block key at column 0");
  });

  it.each([
    ["an anchor", "version: 1\nimports: &records\n  - path: x\n", 2],
    ["quoting", 'version: 1\n"imports":\n  - path: x\n', 2],
    ["a tag", "version: 1\nimports: !!seq\n  - path: x\n", 2],
    ["a flow mapping document", "{ version: 1,\n  imports: [] }\n", 2],
    ["a one-line flow mapping document", "{ version: 1, imports: [] }\n", 1],
  ])("refuses %s", (_label, text, line) => {
    expect(refusal(readImportsSection(text)).line).toBe(line);
  });

  it("refuses an indented key at the top level", () => {
    const refused = refusal(readImportsSection("  version: 1\n  imports:\n    - path: x\n"));
    expect(refused.line).toBe(2);
  });

  it("refuses a repeated key at the second occurrence", () => {
    const refused = refusal(
      readImportsSection(`version: 1\n${section(["skills/pdf"])}name: personal-brain\nimports:\n`),
    );
    expect(refused.line).toBe(17);
    expect(refused.message).toContain("more than once");
  });

  it("ignores an indented imports key nested under another key", () => {
    expect(readImportsSection("version: 1\ndocs:\n  imports: yes\n")).toEqual(
      Result.succeed({ records: [] }),
    );
  });

  it("refuses a section that is not a list", () => {
    expect(refusal(readImportsSection("version: 1\nimports:\n  path: x\n")).line).toBe(2);
  });

  it("refuses a key line inside a multi-line value that does not parse", () => {
    expect(refusal(readImportsSection('version: 1\nnotes: "one\nimports:\ntwo"\n')).line).toBe(1);
  });

  it("refuses a file that is not YAML or not a mapping", () => {
    expect(refusal(readImportsSection("version: [1\n")).message).toContain("does not parse");
    expect(refusal(readImportsSection("- a\n- b\n")).message).toContain("mapping");
    expect(refusal(readImportsSection("")).message).toContain("mapping");
  });

  it("names the record index and block line when a record does not decode", () => {
    const text = `version: 1\n${section(["skills/pdf"])}`.replace(
      "transport: https",
      "transport: Git",
    );
    const refused = refusal(readImportsSection(text));
    expect(refused.line).toBe(3);
    expect(refused.message).toContain("Import record 1 in the block at line 3");
  });

  it("refuses an unknown record key written by a newer release", () => {
    const text = `version: 1\n${section(["skills/pdf"])}`.replace(
      "    transport: https\n",
      "    transport: https\n    mirror: x\n",
    );
    expect(refusal(readImportsSection(text)).message).toContain("Import record 1");
  });

  it("refuses two records for one folder", () => {
    const text = `version: 1\nimports:\n${block("skills/pdf")}${block("skills/pdf")}`;
    expect(refusal(readImportsSection(text)).message).toContain("skills/pdf");
  });

  it("keeps trailing blank lines and a column-0 comment outside the span", () => {
    const text = `version: 1\n${section(["skills/pdf"])}\n# next\nname: personal-brain\n`;
    expect(readImportsSection(text)).toEqual(
      Result.succeed({
        records: [record("skills/pdf")],
        span: { startLine: 2, keyLine: 3, endLine: 15 },
      }),
    );
  });

  it("does not mistake the lines of a following key for the section", () => {
    const text = `version: 1\nimports:\n${block("skills/pdf")}skills:\n  - path: skills\n`;
    const result = readImportsSection(text);
    expect(Result.isSuccess(result) && result.success.span?.endLine).toBe(14);
  });
});

describe("editImportsSection", () => {
  it("appends the section after one blank line when there is none", () => {
    expect(edit("version: 1\nname: personal-brain\n", [record("skills/pdf")])).toBe(
      `version: 1\nname: personal-brain\n\n${section(["skills/pdf"])}`,
    );
  });

  it("terminates a last line that has no newline before the blank line", () => {
    expect(edit("version: 1", [record("skills/pdf")])).toBe(
      `version: 1\n\n${section(["skills/pdf"])}`,
    );
  });

  it("does not add a second blank line when the file already ends with one", () => {
    expect(edit("version: 1\n\n", [record("skills/pdf")])).toBe(
      `version: 1\n\n${section(["skills/pdf"])}`,
    );
  });

  it("appends in the file's CRLF line endings, leaving the original bytes as a prefix", () => {
    const original =
      "# personal-brain\r\nversion: 1\r\nskills:\r\n  - path: skills\r\n\r\ndepends-on:\r\n  - acme\r\n";
    const result = edit(original, [record("skills/pdf")]);
    expect(result).toBe(`${original}\r\n${section(["skills/pdf"], "\r\n")}`);
    expect(result.startsWith(original)).toBe(true);
  });

  it("replaces a section in the middle and keeps comments and the following keys", () => {
    const original = `# top\nversion: 1 # inline\n\n${section(["skills/pdf"])}\n# about skills\nskills:\n  - path: skills\n`;
    expect(edit(original, [record("skills/pdf"), record("skills/docx")])).toBe(
      `# top\nversion: 1 # inline\n\n${section(["skills/docx", "skills/pdf"])}\n# about skills\nskills:\n  - path: skills\n`,
    );
  });

  it("keeps an authored comment above the key outside the span", () => {
    const original = `version: 1\n# my own note\nimports:\n${block("skills/pdf")}`;
    const result = edit(original, [record("skills/pdf"), record("skills/docx")]);
    expect(result).toBe(`version: 1\n# my own note\n${section(["skills/docx", "skills/pdf"])}`);
  });

  it("keeps an indented comment after the last record outside the span", () => {
    const original = `version: 1\n${section(["skills/pdf"])}  # my own note\nname: personal-brain\n`;
    expect(edit(original, [record("skills/pdf"), record("skills/docx")])).toBe(
      `version: 1\n${section(["skills/docx", "skills/pdf"])}  # my own note\nname: personal-brain\n`,
    );
  });

  it("adopts Tack's comment line as part of the section", () => {
    const original = `version: 1\n${section(["skills/pdf"])}`;
    const result = edit(original, [record("skills/pdf")]);
    expect(result.split(importsSectionComment).length).toBe(2);
  });

  it("is idempotent for the same records", () => {
    const once = edit("version: 1\nname: personal-brain\n", [record("skills/pdf")]);
    expect(edit(once, [record("skills/pdf")])).toBe(once);
    const crlf = edit("version: 1\r\n", [record("skills/pdf")]);
    expect(edit(crlf, [record("skills/pdf")])).toBe(crlf);
  });

  it("rewrites only the block on a second edit", () => {
    const original = "version: 1\nname: personal-brain\n\n# keep\nskills:\n  - path: skills\n";
    const first = edit(original, [record("skills/pdf")]);
    const second = edit(first, [record("skills/pdf"), record("skills/docx")]);
    expect(
      second.startsWith("version: 1\nname: personal-brain\n\n# keep\nskills:\n  - path: skills\n"),
    ).toBe(true);
    expect(second).toBe(`${original}\n${section(["skills/docx", "skills/pdf"])}`);
  });

  it("keeps a section that ends the file without a newline in the same shape", () => {
    const original = `version: 1\n${section(["skills/pdf"])}`.slice(0, -1);
    const result = edit(original, [record("skills/pdf"), record("skills/docx")]);
    expect(result.endsWith("}")).toBe(true);
    expect(result).toBe(`version: 1\n${section(["skills/docx", "skills/pdf"])}`.slice(0, -1));
  });

  it("removes the section and its comment line for an empty list, keeping other bytes", () => {
    const original = `version: 1\n\n${section(["skills/pdf"])}\n# tail\nname: personal-brain\n`;
    expect(edit(original, [])).toBe("version: 1\n\n\n# tail\nname: personal-brain\n");
  });

  it("returns the original text for an empty list and no section", () => {
    expect(edit("version: 1\n", [])).toBe("version: 1\n");
  });

  it("keeps every byte outside the section for several shapes", () => {
    const outers = [
      ["version: 1\n", ""],
      ["# c\nversion: 1\nname: 'quoted'   \n\n\n", "\n\n# d\nskills: [ {path: skills} ]\n"],
      ["version: 1\r\n\r\n", "name: personal-brain\r\n"],
      ["version: 1\n", "docs:\n  - path: docs\n"],
    ] as const;
    outers.forEach(([before, after]) => {
      const eol = before.includes("\r\n") ? "\r\n" : "\n";
      const original = `${before}${section(["skills/pdf"], eol)}${after}`;
      const result = edit(original, [record("skills/pdf", { revision: "ba98".repeat(10) })]);
      expect(result.startsWith(before)).toBe(true);
      expect(result.endsWith(after)).toBe(true);
    });
  });

  it("sorts records by path and writes ref when present", () => {
    const result = edit("version: 1\n", [
      record("skills/b", { "ref-kind": "tag", ref: "v1.2.3" }),
      record("skills/a"),
    ]);
    expect(result.indexOf("path: skills/a")).toBeLessThan(result.indexOf("path: skills/b"));
    expect(result).toContain("    ref-kind: tag\n    ref: v1.2.3\n");
    expect(readImportsSection(result)).toMatchObject({
      success: { records: [{ path: "skills/a" }, { path: "skills/b" }] },
    });
  });

  it("writes an empty files list", () => {
    const result = edit("version: 1\n", [record("skills/a", {}, [])]);
    expect(result).toContain("    files: []\n");
    expect(Result.isSuccess(readImportsSection(result))).toBe(true);
  });

  it.each([
    ["spaces", "skills/my skill"],
    ["a hash", "skills/a#b"],
    ["a colon and space", "skills/a: b"],
    ["a leading dash", "-skills/a"],
    ["a leading digit", "2024/skill"],
    ["flow punctuation", "skills/a,b]"],
    ["a quote", 'skills/a"b'],
    ["unicode", "skills/café"],
    ["a boolean look-alike", "true"],
    ["a null look-alike", "null"],
    ["a number look-alike", "1e5"],
    ["a trailing colon", "skills/a:"],
  ])("round-trips a path with %s", (_label, path) => {
    const files = [
      { path: `${path}/SKILL.md`, sha256: sha, executable: false },
      { path: path, sha256: sha, executable: false },
    ].sort((left, right) => (left.path < right.path ? -1 : 1));
    const records = [record(path, { "upstream-path": path }, files)];
    const result = edit("version: 1\n", records);
    expect(readImportsSection(result)).toEqual(
      Result.succeed({ records, span: expect.anything() }),
    );
  });

  it("writes hashes that look like numbers as strings", () => {
    const risky = "1".repeat(40);
    const result = edit("version: 1\n", [record("skills/a", { revision: risky })]);
    expect(result).toContain(`revision: "${risky}"`);
    expect(Result.isSuccess(readImportsSection(result))).toBe(true);
  });

  it("refuses a file Tack cannot own and writes nothing", () => {
    expect(
      refusal(editImportsSection("version: 1\nimports: []\n", [record("skills/a")])).line,
    ).toBe(2);
  });

  it("refuses an empty file", () => {
    expect(refusal(editImportsSection("", [record("skills/a")])).message).toContain("mapping");
  });

  it("refuses records that do not decode or repeat a folder", () => {
    expect(
      Result.isFailure(editImportsSection("version: 1\n", [record("skills/a", { revision: "x" })])),
    ).toBe(true);
    expect(
      Result.isFailure(
        editImportsSection("version: 1\n", [record("skills/a"), record("skills/a")]),
      ),
    ).toBe(true);
  });

  it("aborts when the rewritten file would change another key", () => {
    // A keep-chomped block scalar absorbs the blank separator line, changing the author's value.
    const original = "version: 1\nnotes: |+\n  one\n";
    const result = editImportsSection(original, [record("skills/a")]);
    expect(Result.isFailure(result)).toBe(true);
  });

  it("aborts when another key aliases an anchor inside the section", () => {
    const original = "version: 1\nimports:\n  - &first skills/a\nnotes: *first\n";
    const refused = refusal(editImportsSection(original, [record("skills/a")]));
    expect(refused.line).toBe(1);
  });
});
