import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unified } from "unified";
import { readerBoot } from "./boot.ts";
import { corpusIconNames } from "./icons/collect.ts";
import { loadProjectCorpus } from "./project-corpus.ts";
import type { ReaderProjectInput } from "./types.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function resource(name: string) {
  const sourcePath = await realpath(await mkdtemp(join(tmpdir(), `tack-reader-${name}-`)));
  temporary.push(sourcePath);
  const directoryPath = join(sourcePath, "docs");
  await mkdir(directoryPath);
  return { sourcePath, directoryPath };
}

describe("project reader corpus", () => {
  it("loads healthy optional Markdown resources while reporting another resource's failure", async () => {
    const healthy = await resource("healthy");
    const broken = await resource("broken");
    await Promise.all([
      writeFile(join(healthy.directoryPath, "guide.md"), "# Shared guide\n\nSaved prose.\n"),
      writeFile(
        join(healthy.directoryPath, "reference.mdx"),
        "---\ntitle: Reference page\ntype: source-guide\nstatus: inherited\ntags: [source, ordinary]\ndescription: Existing source metadata\nsidebar_position: 2\n---\n\n# Reference\n",
      ),
      writeFile(
        join(broken.directoryPath, "broken.mdx"),
        'import Detail from "./missing.mdx"\n\n<Detail />\n',
      ),
    ]);
    const input = {
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "docs-a",
          ...healthy,
        },
        {
          sourceRegistrationId: "source-b",

          name: "docs-b",
          ...broken,
        },
      ],
      issues: [],
    } satisfies ReaderProjectInput;

    const corpus = await loadProjectCorpus(input);

    expect(corpus.complete).toBe(false);
    expect(corpus.documents).toMatchObject([
      {
        title: "Shared guide",
        relativePath: "guide.md",
        route: "/docs/source-a/docs-a/guide",
        resource: {
          sourceRegistrationId: "source-a",

          name: "docs-a",
          sourcePath: healthy.sourcePath,
        },
      },
      {
        title: "Reference page",
        relativePath: "reference.mdx",
        route: "/docs/source-a/docs-a/reference",
      },
    ]);
    expect(corpus.issues).toMatchObject([
      {
        resource: { sourceRegistrationId: "source-b", name: "docs-b" },
        sourcePath: broken.sourcePath,
        code: "document-load",
        path: join(broken.directoryPath, "broken.mdx"),
      },
    ]);
    expect(corpus.resources).toHaveLength(2);
  });

  it("reports every malformed document once and keeps valid siblings available", async () => {
    const entry = await resource("mixed");
    await Promise.all([
      writeFile(join(entry.directoryPath, "one.md"), "# One\n"),
      writeFile(join(entry.directoryPath, "two.md"), "# Two\n"),
      writeFile(join(entry.directoryPath, "three.mdx"), "# Three\n"),
      writeFile(join(entry.directoryPath, "bad-one.mdx"), "# Bad\n\n<Unclosed>\n"),
      writeFile(
        join(entry.directoryPath, "bad-two.mdx"),
        'import Gone from "./missing.mdx"\n\n<Gone />\n',
      ),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "source-a", name: "docs-a", ...entry }],
      issues: [],
    });

    expect(corpus.documents.map((document) => document.relativePath)).toEqual([
      "one.md",
      "three.mdx",
      "two.md",
    ]);
    expect(corpus.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["document-load", join(entry.directoryPath, "bad-one.mdx")],
      ["document-load", join(entry.directoryPath, "bad-two.mdx")],
    ]);
    for (const issue of corpus.issues) expect(issue.message).toContain(issue.path);
    expect(corpus.complete).toBe(false);
  });

  it("leaves one resource unavailable for a broken reader config without hiding another resource", async () => {
    const broken = await resource("broken-config");
    const healthy = await resource("healthy-config");
    const configPath = join(broken.sourcePath, "reader.yaml");
    await Promise.all([
      writeFile(configPath, "version: 1\ncontent: [unterminated\n"),
      writeFile(join(broken.directoryPath, "hidden.md"), "# Hidden\n"),
      writeFile(join(healthy.directoryPath, "visible.md"), "# Visible\n"),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "broken",
          ...broken,
          readerConfig: { kind: "file", path: configPath },
        },
        { sourceRegistrationId: "source-a", name: "healthy", ...healthy },
      ],
      issues: [],
    });

    expect(corpus.documents.map((document) => document.title)).toEqual(["Visible"]);
    expect(corpus.issues).toHaveLength(1);
    expect(corpus.issues[0]).toMatchObject({
      resource: { name: "broken" },
      code: "resource-load",
    });
    expect(corpus.issues[0]?.path).toBeUndefined();
    expect(corpus.issues[0]?.message).toContain(configPath);
    expect(corpus.complete).toBe(false);
  });

  it("skips render-module compilation for search while serving still checks it", async () => {
    const entry = await resource("render");
    await Promise.all([
      writeFile(join(entry.directoryPath, "plain.md"), "# Plain\n\nneedle prose\n"),
      writeFile(join(entry.sourcePath, "components.tsx"), "export const components = {{{ broken\n"),
      writeFile(
        join(entry.sourcePath, "reader.yaml"),
        stringify({
          version: 1,
          content: [{ root: "docs", include: ["**/*.md"], exclude: [] }],
          navigation: { preset: "folders" },
          layouts: { preset: "reader" },
          components: { module: "components.tsx" },
          metadata: { preset: "working-docs" },
        }),
      ),
    ]);
    const input = {
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "docs-a",
          ...entry,
          readerConfig: { kind: "file", path: join(entry.sourcePath, "reader.yaml") },
        },
      ],
      issues: [],
    } satisfies ReaderProjectInput;

    const searched = await loadProjectCorpus(input, { renderModules: "skip" });
    expect(searched.documents.map((document) => document.title)).toEqual(["Plain"]);
    expect(searched.complete).toBe(true);

    const served = await loadProjectCorpus(input);
    expect(served.documents).toEqual([]);
    expect(served.issues[0]?.code).toBe("resource-load");
  });

  it("keeps explicit configuration content inside its declared docs resource", async () => {
    const entry = await resource("bounded");
    await mkdir(join(entry.sourcePath, "outside"));
    const configPath = join(entry.sourcePath, "reader.yaml");
    await writeFile(
      configPath,
      stringify({
        version: 1,
        content: [{ root: "outside", include: ["**/*.mdx"], exclude: [] }],
        navigation: { preset: "folders" },
        layouts: { preset: "reader" },
        components: { preset: "standard" },
        metadata: { preset: "working-docs" },
      }),
    );

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "docs-a",
          ...entry,
          readerConfig: { kind: "file", path: configPath },
        },
      ],
      issues: [],
    });

    expect(corpus.documents).toEqual([]);
    expect(corpus.issues[0]?.message).toMatch(/inside declared docs resource/i);
  });

  it("loads a resource whose configured content roots and archive folders are absent", async () => {
    const entry = await resource("optional-directories");
    const configPath = join(entry.sourcePath, "reader.yaml");
    await Promise.all([
      writeFile(join(entry.directoryPath, "guide.md"), "# Guide\n"),
      writeFile(
        configPath,
        stringify({
          version: 1,
          content: [{ root: "docs" }, { root: "docs/decisions" }, { root: "docs/research" }],
          navigation: { preset: "folders", archive: ["docs/archive"] },
        }),
      ),
    ]);
    const input = {
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "docs-a",
          ...entry,
          readerConfig: { kind: "file", path: configPath },
        },
      ],
      issues: [],
    } satisfies ReaderProjectInput;

    const before = await loadProjectCorpus(input);
    expect(before.issues).toEqual([]);
    expect(before.complete).toBe(true);
    expect(before.documents.map((document) => document.relativePath)).toEqual(["guide.md"]);

    await mkdir(join(entry.directoryPath, "decisions"));
    await writeFile(join(entry.directoryPath, "decisions", "choice.md"), "# Choice\n");
    const after = await loadProjectCorpus(input);
    expect(after.issues).toEqual([]);
    expect(after.documents.map((document) => document.relativePath)).toEqual([
      "decisions/choice.md",
      "guide.md",
    ]);
  });

  it("merges a partial source configuration with ordinary Markdown defaults", async () => {
    const entry = await resource("partial");
    const configPath = join(entry.sourcePath, "reader.yaml");
    await Promise.all([
      writeFile(join(entry.directoryPath, "guide.md"), "---\ntags: [source-tag]\n---\n# Guide\n"),
      writeFile(join(entry.directoryPath, "components.tsx"), "export const Card = () => <div />\n"),
      writeFile(
        configPath,
        stringify({
          version: 1,
          content: [{ root: "docs" }],
          navigation: {},
          layouts: {},
          components: { module: "docs/components.tsx" },
          metadata: {},
        }),
      ),
    ]);
    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",

          name: "docs",
          ...entry,
          readerConfig: { kind: "file", path: configPath },
        },
      ],
      issues: [],
    });
    expect(corpus.complete).toBe(true);
    expect(corpus.documents[0]).toMatchObject({
      title: "Guide",
      metadata: { tags: ["source-tag"] },
    });
  });

  it("isolates a broken source component and includes it after a saved repair", async () => {
    const healthy = await resource("component-healthy");
    const broken = await resource("component-broken");
    await Promise.all([
      writeFile(join(healthy.directoryPath, "guide.md"), "# Healthy\n"),
      writeFile(
        join(broken.directoryPath, "guide.mdx"),
        'import Card from "./card.tsx"\n\n<Card />\n',
      ),
      writeFile(
        join(broken.directoryPath, "card.tsx"),
        '// import "./comment-only-missing.ts"\nimport type { MissingType } from "./type-only.ts"\nimport "./style.css"\nimport values from "./values.json"\nimport { label } from "./missing.ts"\nexport default () => <div>{label}{values.suffix}</div>\n',
      ),
      writeFile(join(broken.directoryPath, "values.json"), '{"suffix":"!"}\n'),
      writeFile(
        join(broken.directoryPath, "style.css"),
        '@import "./nested.css";\n.card { background: url("./icon.svg"); color: green; }\n',
      ),
      writeFile(join(broken.directoryPath, "nested.css"), ".nested { color: black; }\n"),
      writeFile(
        join(broken.directoryPath, "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      ),
    ]);
    const input = {
      project: { name: "Tack", root: "/project" },
      resources: [
        { sourceRegistrationId: "source-a", name: "docs", ...healthy },
        { sourceRegistrationId: "source-b", name: "docs", ...broken },
      ],
      issues: [],
    } satisfies ReaderProjectInput;

    const failed = await loadProjectCorpus(input);
    expect(failed.documents.map((document) => document.title)).toEqual(["Healthy"]);
    expect(failed.issues[0]).toMatchObject({
      resource: { sourceRegistrationId: "source-b" },
      code: "resource-load",
    });

    await writeFile(join(broken.directoryPath, "missing.ts"), 'export const label = "Recovered"\n');
    const repaired = await loadProjectCorpus(input);
    expect(repaired.complete).toBe(true);
    expect(repaired.documents.map((document) => document.title)).toEqual(["Healthy", "guide"]);
  });

  it("isolates an MDX document with a missing bare package import", async () => {
    const healthy = await resource("bare-import-healthy");
    const broken = await resource("bare-import-broken");
    await Promise.all([
      writeFile(join(healthy.directoryPath, "guide.md"), "# Healthy\n"),
      writeFile(
        join(broken.directoryPath, "guide.mdx"),
        'import Widget from "certainly-missing-tack-reader-package"\n\n# Broken\n\n<Widget />\n',
      ),
    ]);
    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        { sourceRegistrationId: "healthy", name: "docs", ...healthy },
        { sourceRegistrationId: "broken", name: "docs", ...broken },
      ],
      issues: [],
    });
    expect(corpus.documents.map((document) => document.title)).toEqual(["Healthy"]);
    expect(corpus.issues).toMatchObject([
      { resource: { sourceRegistrationId: "broken", name: "docs" } },
    ]);
  });

  it("provides React DOM to a source component module, so it can use a portal", async () => {
    const source = await resource("portal");
    await Promise.all([
      writeFile(
        join(source.directoryPath, "portal.tsx"),
        'import { createPortal } from "react-dom";\nexport const Portal = () => createPortal(<p>Out</p>, document.body);\n',
      ),
      writeFile(
        join(source.directoryPath, "page.mdx"),
        'import { Portal } from "./portal.tsx"\nimport { flushSync } from "react-dom"\n\n# Portal page\n\n<Portal />\n',
      ),
    ]);
    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "portal", name: "docs", ...source }],
      issues: [],
    });
    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.map((document) => document.title)).toEqual(["Portal page"]);
  });

  it("rejects an absolute MDX import without losing a healthy resource", async () => {
    const healthy = await resource("absolute-import-healthy");
    const broken = await resource("absolute-import-broken");
    await Promise.all([
      writeFile(join(healthy.directoryPath, "guide.md"), "# Healthy\n"),
      writeFile(
        join(broken.directoryPath, "guide.mdx"),
        'import Widget from "/outside-source.ts"\n\n# Broken\n\n<Widget />\n',
      ),
    ]);
    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        { sourceRegistrationId: "healthy", name: "docs", ...healthy },
        { sourceRegistrationId: "broken", name: "docs", ...broken },
      ],
      issues: [],
    });
    expect(corpus.documents.map((document) => document.title)).toEqual(["Healthy"]);
    expect(corpus.issues[0]?.message).toContain("must stay relative");
  });
  it("compiles extensionless, cyclic and package imports of source components", async () => {
    const source = await resource("imports");
    const fixturePackage = join(source.directoryPath, "node_modules", "tack-fixture-widget");
    await mkdir(fixturePackage, { recursive: true });
    await Promise.all([
      writeFile(
        join(fixturePackage, "package.json"),
        JSON.stringify({ name: "tack-fixture-widget", type: "module", main: "index.js" }),
      ),
      writeFile(join(fixturePackage, "index.js"), 'export default () => "widget";\n'),
      writeFile(
        join(source.directoryPath, "label.js"),
        'import { suffix } from "./cycle-a";\nexport const label = `Label${suffix}`;\n',
      ),
      writeFile(
        join(source.directoryPath, "cycle-a.ts"),
        'import { mark } from "./cycle-b.ts";\nexport const suffix = mark;\nexport const prefix = "a";\n',
      ),
      writeFile(
        join(source.directoryPath, "cycle-b.ts"),
        'import { prefix } from "./cycle-a.ts";\nexport const mark = () => prefix;\n',
      ),
      writeFile(
        join(source.directoryPath, "first.mdx"),
        'import { label } from "./label"\nimport Widget from "tack-fixture-widget"\n\n# First\n\n<Widget />\n',
      ),
      writeFile(
        join(source.directoryPath, "second.mdx"),
        'import Widget from "tack-fixture-widget"\n\n# Second\n\n<Widget />\n',
      ),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "imports", name: "docs", ...source }],
      issues: [],
    });

    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.map((document) => document.title)).toEqual(["First", "Second"]);
  });

  it("loads a .jsx source component that contains JSX", async () => {
    const source = await resource("jsx-component");
    await Promise.all([
      writeFile(
        join(source.directoryPath, "card.jsx"),
        'import { label } from "./label.ts";\nexport default () => <b>{label}</b>;\n',
      ),
      writeFile(join(source.directoryPath, "label.ts"), 'export const label = "Card";\n'),
      writeFile(
        join(source.directoryPath, "guide.mdx"),
        'import Card from "./card.jsx"\n\n# Guide\n\n<Card />\n',
      ),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "jsx", name: "docs", ...source }],
      issues: [],
    });

    expect(corpus.issues).toEqual([]);
    expect(corpus.documents.map((document) => document.title)).toEqual(["Guide"]);
  });

  it("reports the compiler's message when a source component fails to bundle", async () => {
    const source = await resource("bundle-failure");
    await Promise.all([
      writeFile(
        join(source.directoryPath, "card.tsx"),
        'import Missing from "tack-reader-fixture-missing-library";\nexport default () => <Missing />;\n',
      ),
      writeFile(
        join(source.directoryPath, "guide.mdx"),
        'import Card from "./card.tsx"\n\n# Guide\n\n<Card />\n',
      ),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "bundle", name: "docs", ...source }],
      issues: [],
    });

    expect(corpus.documents).toEqual([]);
    expect(corpus.issues).toMatchObject([
      {
        code: "resource-load",
        message: expect.stringContaining('Could not resolve "tack-reader-fixture-missing-library"'),
      },
    ]);
  });

  it("rejects a component import that a link resolves outside the source checkout", async () => {
    const source = await resource("linked-import");
    const outside = await resource("linked-import-target");
    await writeFile(join(outside.directoryPath, "helper.ts"), "export const helper = 1;\n");
    await Promise.all([
      symlink(join(outside.directoryPath, "helper.ts"), join(source.directoryPath, "helper.ts")),
      writeFile(
        join(source.directoryPath, "card.tsx"),
        'import { helper } from "./helper.ts";\nexport default () => <b>{helper}</b>;\n',
      ),
      writeFile(
        join(source.directoryPath, "guide.mdx"),
        'import Card from "./card.tsx"\n\n# Guide\n\n<Card />\n',
      ),
    ]);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [{ sourceRegistrationId: "linked", name: "docs", ...source }],
      issues: [],
    });

    expect(corpus.documents).toEqual([]);
    expect(corpus.issues).toMatchObject([
      {
        code: "resource-load",
        message: `${join(source.directoryPath, "card.tsx")}: imported source ./helper.ts resolves outside the registered source checkout.`,
      },
    ]);
  });

  it("rejects a docs directory that a link resolves outside the source checkout", async () => {
    const source = await resource("linked-docs");
    const outside = await resource("linked-docs-target");
    const linked = join(source.sourcePath, "linked-docs");
    await symlink(outside.directoryPath, linked);

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "linked",
          name: "docs",
          sourcePath: source.sourcePath,
          directoryPath: linked,
        },
      ],
      issues: [],
    });

    expect(corpus.issues).toMatchObject([
      {
        code: "resource-load",
        message: "docs: docs directory must stay inside the registered source checkout.",
      },
    ]);
  });

  it("keeps configured archive folders inside the declared docs resource", async () => {
    const entry = await resource("archive-bounds");
    await mkdir(join(entry.sourcePath, "outside"));
    const configPath = join(entry.sourcePath, "reader.yaml");
    await writeFile(
      configPath,
      stringify({
        version: 1,
        content: [{ root: "docs" }],
        navigation: { preset: "folders", archive: ["outside"] },
      }),
    );

    const corpus = await loadProjectCorpus({
      project: { name: "Tack", root: "/project" },
      resources: [
        {
          sourceRegistrationId: "source-a",
          name: "docs-a",
          ...entry,
          readerConfig: { kind: "file", path: configPath },
        },
      ],
      issues: [],
    });

    expect(corpus.documents).toEqual([]);
    expect(corpus.issues[0]?.message).toBe(
      `docs-a: reader configuration archive folders must stay inside declared docs resource ${entry.directoryPath}.`,
    );
  });
});

describe("parsing a project corpus", () => {
  const texts = {
    "guide.md": "# Guide\n\nPlain prose.\n",
    "icons.mdx":
      '# Icons\n\nimport Shared from "./shared.mdx"\n\n<Icon name="house" />\n\n<Callout icon="rocket" kind="note">Go</Callout>\n\n<Shared />\n',
    "shared.mdx": "Shared fragment.\n",
  };

  async function parsedCorpus() {
    const docs = await resource("parsed");
    await Promise.all(
      Object.entries(texts).map(([name, text]) => writeFile(join(docs.directoryPath, name), text)),
    );
    const input = {
      project: { name: "Tack", root: docs.sourcePath },
      resources: [{ sourceRegistrationId: "source-a", name: "docs-a", ...docs }],
      issues: [],
    } satisfies ReaderProjectInput;
    // Every remark parser of the reader is a unified processor, so this counts each full parse.
    const parse = vi.spyOn(Object.getPrototypeOf(unified), "parse");
    const parses = () =>
      Object.fromEntries(
        Object.entries(texts).map(([name, text]) => [
          name,
          parse.mock.calls.filter(([value]) => value === text).length,
        ]),
      );
    return { docs, input, parse, parses };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses each document once from its load through the icon and component checks", async () => {
    const { input, parses } = await parsedCorpus();

    const corpus = await loadProjectCorpus(input);
    const names = await corpusIconNames(corpus);
    const boot = readerBoot({ input, corpus, generation: "one", token: "session", checkout: null });

    expect(corpus.documents.map((document) => document.relativePath)).toEqual(Object.keys(texts));
    expect(names).toEqual(["house", "rocket"]);
    expect(boot.iconIssues).toEqual([]);
    expect(boot.componentIssues).toEqual([]);
    expect(parses()).toEqual({ "guide.md": 1, "icons.mdx": 1, "shared.mdx": 1 });
  });

  it("reloads without parsing again, and forgets a document the corpus no longer holds", async () => {
    const { docs, input, parse, parses } = await parsedCorpus();
    const guide = join(docs.directoryPath, "guide.md");
    await loadProjectCorpus(input);
    await rm(guide);
    await loadProjectCorpus(input);
    await writeFile(guide, texts["guide.md"]);
    parse.mockClear();

    const corpus = await loadProjectCorpus(input);

    expect(corpus.documents).toHaveLength(3);
    expect(parses()).toEqual({ "guide.md": 1, "icons.mdx": 0, "shared.mdx": 0 });
  });
});
