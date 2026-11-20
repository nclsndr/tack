import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadProjectCorpus } from "./project-corpus.ts";
import type { ReaderProjectInput } from "./types.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(reader: unknown) {
  const sourcePath = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-yaml-")));
  temporary.push(sourcePath);
  const directoryPath = join(sourcePath, "docs");
  await mkdir(directoryPath);
  await writeFile(join(directoryPath, "guide.md"), "# Guide\n");
  await writeFile(join(directoryPath, "hidden.md"), "# Hidden\n");
  const path = join(sourcePath, "tack.yaml");
  const save = async (value: unknown) =>
    writeFile(
      path,
      stringify({ version: 1, docs: [{ name: "handbook", path: "docs", reader: value }] }),
    );
  await save(reader);
  const entry = {
    sourceRegistrationId: "source-a",

    name: "handbook",
    sourcePath,
    directoryPath,
    readerConfig: { kind: "source" as const, path },
  };
  const input: ReaderProjectInput = {
    project: { name: "demo", root: sourcePath },
    resources: [entry],
    issues: [],
  };
  return { sourcePath, directoryPath, path, save, input, entry };
}

const selection = { content: [{ root: "docs", exclude: ["hidden.md"] }] };

describe("source-owned YAML reader configuration", () => {
  it("reads a docs entry and its settings from a declaration that also holds resource keys", async () => {
    const { input, path } = await fixture(selection);
    await writeFile(
      path,
      stringify({
        version: 1,
        name: "mixed",
        skills: [{ path: "skills", exclude: ["**/_*/**"] }],
        commands: [{ path: "commands" }],
        context: [{ path: "context", include: ["**/*.md"] }],
        scripts: [{ name: "report", path: "tools/report.ts", description: "Report" }],
        docs: [{ name: "handbook", path: "docs", reader: selection }],
      }),
    );
    expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual(["Guide"]);
  });

  it("reads the top-level reader settings of a docs collection, which is its whole folder", async () => {
    const { input, path, sourcePath } = await fixture(selection);
    await writeFile(join(sourcePath, "top.md"), "# Top\n");
    await writeFile(
      path,
      stringify({ version: 1, kind: "docs", name: "handbook", reader: selection }),
    );
    const collection = {
      ...input,
      resources: input.resources.map((resource) => ({ ...resource, directoryPath: sourcePath })),
    };
    expect((await loadProjectCorpus(collection)).documents.map((doc) => doc.title)).toEqual([
      "Guide",
    ]);
    await writeFile(path, stringify({ version: 1, kind: "docs", name: "handbook" }));
    expect((await loadProjectCorpus(collection)).documents.map((doc) => doc.title).sort()).toEqual([
      "Guide",
      "Hidden",
      "Top",
    ]);
    await writeFile(path, stringify({ version: 1, kind: "docs", name: "other" }));
    expect((await loadProjectCorpus(collection)).issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("handbook is no longer declared"),
      }),
    ]);
  });

  it("reads profile-bearing version-2 source settings without loading their modules", async () => {
    const { input, path } = await fixture(selection);
    await writeFile(
      path,
      stringify({
        version: 2,
        profiles: [{ name: "ci", path: "ci.yaml" }],
        docs: [{ name: "handbook", path: "docs", reader: selection }],
      }),
    );
    expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual(["Guide"]);
  });

  it("loads inline settings, reloads saved edits, and returns to defaults when removed", async () => {
    const { input, save } = await fixture(selection);
    expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual(["Guide"]);
    await save({ content: [{ root: "docs", exclude: ["guide.md"] }] });
    expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual(["Hidden"]);
    await save(undefined);
    expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual([
      "Guide",
      "Hidden",
    ]);
  });

  it.each(["yaml", "yml"])(
    "loads a linked %s file and keeps its paths source-relative",
    async (extension) => {
      const { input, sourcePath, save } = await fixture({});
      await mkdir(join(sourcePath, "reader"));
      const path = join(sourcePath, `reader/handbook.${extension}`);
      await writeFile(path, "# Reader selection\n" + stringify(selection));
      await save(`reader/handbook.${extension}`);
      const loaded = await loadProjectCorpus(input);
      expect(loaded.complete).toBe(true);
      expect(loaded.documents.map((doc) => doc.title)).toEqual(["Guide"]);
      expect(loaded.resources[0]?.config?.configPath).toBe(path);
      await writeFile(path, "content:\n  - root: docs\n    exclude: [guide.md]\n");
      expect((await loadProjectCorpus(input)).documents.map((doc) => doc.title)).toEqual([
        "Hidden",
      ]);
    },
  );

  it.each([
    null,
    false,
    3,
    [],
    { typo: true },
    { version: 2 },
    { components: { module: "" } },
    { content: [{ root: "../outside" }] },
    { navigation: { archive: ["../outside"] } },
    "reader.json",
    "../reader.yaml",
    "/tmp/reader.yaml",
    "reader\\handbook.yaml",
  ])("isolates invalid reader settings %j from a healthy sibling", async (reader) => {
    const { input, entry } = await fixture(reader);
    input.resources.push({ ...entry, name: "healthy", readerConfig: undefined });
    const corpus = await loadProjectCorpus(input);
    expect(corpus.complete).toBe(false);
    expect(corpus.issues).toMatchObject([
      { resource: { name: "handbook" }, code: "resource-load" },
    ]);
    expect(corpus.documents.map((doc) => doc.title)).toEqual(["Guide", "Hidden"]);
  });

  it("reports malformed or missing linked YAML and recovers after a saved repair", async () => {
    const { input, sourcePath } = await fixture("reader.yaml");
    const path = join(sourcePath, "reader.yaml");
    expect((await loadProjectCorpus(input)).complete).toBe(false);
    await writeFile(path, "components: [\n");
    expect((await loadProjectCorpus(input)).issues[0]?.message).toMatch(/valid YAML/);
    await writeFile(path, "{}\n");
    expect((await loadProjectCorpus(input)).complete).toBe(true);
  });

  it("rejects a linked YAML symlink outside the source checkout", async () => {
    const { input, sourcePath } = await fixture("reader.yaml");
    const outside = await fixture({});
    await symlink(outside.path, join(sourcePath, "reader.yaml"));
    expect((await loadProjectCorpus(input)).issues[0]?.message).toMatch(/outside.*source/);
  });

  it("rejects a direct JSON file reference", async () => {
    const { input, entry } = await fixture({});
    entry.readerConfig.path = "reader.json";
    const corpus = await loadProjectCorpus(input);
    expect(corpus.issues[0]?.message).toMatch(/\.yaml or \.yml/);
  });

  it("selects inline configuration by name within a source", async () => {
    const { input, path, entry } = await fixture({});
    await writeFile(
      path,
      stringify({
        version: 1,
        docs: [
          { name: "handbook", path: "docs", reader: selection },
          {
            name: "handbook",

            path: "docs",
            reader: { content: [{ root: "docs", exclude: ["guide.md"] }] },
          },
        ],
      }),
    );
    input.resources.push({ ...entry });
    const corpus = await loadProjectCorpus(input);
    expect(corpus.complete).toBe(true);
    expect(corpus.documents.map((doc) => doc.title)).toEqual(["Guide", "Guide"]);
  });

  it("ignores malformed sibling declarations when reading a healthy resource", async () => {
    const { input, path } = await fixture({});
    await writeFile(
      path,
      stringify({
        version: 1,
        docs: [
          null,
          { name: 42 },
          { name: "bad-owner", owner: "unknown" },
          { name: "handbook", path: "docs", reader: selection },
        ],
      }),
    );
    const corpus = await loadProjectCorpus(input);
    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.map((doc) => doc.title)).toEqual(["Guide"]);
  });

  it("reports a removed resource declaration and malformed source YAML", async () => {
    const { input, path } = await fixture({});
    await writeFile(path, "version: 1\ndocs: []\n");
    expect((await loadProjectCorpus(input)).issues[0]?.message).toMatch(/no longer declared/);
    await writeFile(path, "version: 1\ndocs: [\n");
    expect((await loadProjectCorpus(input)).issues[0]?.message).toMatch(/valid YAML/);
    await writeFile(path, "version: 1\ndocs: wrong\n");
    expect((await loadProjectCorpus(input)).complete).toBe(false);
  });

  it("keeps observed types and statuses valid when only tags are configured", async () => {
    const { input, directoryPath } = await fixture({ metadata: { tags: ["legacy"] } });
    await writeFile(
      join(directoryPath, "guide.md"),
      "---\ntype: research\nstatus: exploring\ntags: [new-tag]\n---\n# Guide\n",
    );
    const corpus = await loadProjectCorpus(input);
    expect(corpus.complete).toBe(true);
    expect(corpus.documents[0]?.metadata).toMatchObject({
      type: "research",
      status: "exploring",
      tags: ["new-tag"],
    });
  });

  it("resolves inline modules and loads new tags despite an existing configured list", async () => {
    const { input, sourcePath } = await fixture({
      components: { module: "components.tsx" },
      metadata: { tags: ["allowed"] },
    });
    await writeFile(join(sourcePath, "components.tsx"), "export const components = {};\n");
    await writeFile(join(sourcePath, "docs", "guide.md"), "---\ntags: [allowed]\n---\n# Guide\n");
    const corpus = await loadProjectCorpus(input);
    expect(corpus.complete).toBe(true);
    expect(corpus.resources[0]?.config?.components.module).toBe(join(sourcePath, "components.tsx"));
    await writeFile(
      join(sourcePath, "docs", "guide.md"),
      "---\ntags: [undeclared]\n---\n# Guide\n",
    );
    const refreshed = await loadProjectCorpus(input);
    expect(refreshed.complete).toBe(true);
    expect(refreshed.issues).toEqual([]);
    expect(refreshed.documents[0]?.metadata.tags).toEqual(["undeclared"]);
  });
});
