import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeDocument,
  formatCopy,
  loadCorpus,
  remarkSourceBlocks,
  sourceBlocksDigest,
  sourceVersion,
} from "./source.ts";
import { loadReaderConfig } from "./config.ts";
import { unified } from "unified";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkFrontmatter from "remark-frontmatter";

const document = `---\ntitle: Reader example\ntype: walkthrough\nstatus: draft\ntags: [example]\n---\n\nimport { steps } from './steps.ts'\nimport Custom from './custom.tsx'\n\n# Physical heading\n\nA **readable** paragraph.\n\n<Walkthrough steps={steps} />\n\n<Custom />\n`;
const temporary: string[] = [];

async function corpusFixture(files: Record<string, string>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-corpus-")));
  temporary.push(directory);
  await mkdir(join(directory, "reader"));
  await writeFile(
    join(directory, "tack.reader.yaml"),
    stringify({
      version: 1,
      content: [{ root: "reader", include: ["page.mdx"], exclude: [] }],
      navigation: { preset: "folders" },
      layouts: { preset: "reader" },
      components: { preset: "standard" },
      metadata: { preset: "working-docs" },
    }),
  );
  await Promise.all(
    Object.entries(files).map(async ([name, source]) => {
      await mkdir(join(directory, "reader", name, ".."), { recursive: true });
      await writeFile(join(directory, "reader", name), source);
    }),
  );
  return { directory, config: await loadReaderConfig(directory) };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("sourceVersion", () => {
  // Pinned values: how the hash is computed may change, the version of a block may not.
  it.each([
    ["", "ztntfp"],
    ["a", "1r9wi7g"],
    ["before", "fm3l1a"],
    ["Saved content.\n", "1m4m759"],
    ["emoji 🧭 and é", "1t0ug4c"],
  ])("hashes %j to %s", (text, version) => {
    expect(sourceVersion(text)).toBe(version);
  });
});

describe("authored source provenance", () => {
  it("preserves physical frontmatter offsets and separates authored blocks", () => {
    const result = analyzeDocument("/project/reader/example.mdx", document);
    expect(result.title).toBe("Reader example");
    expect(
      result.blocks.map((block) => [block.kind, block.source.startLine, block.source.endLine]),
    ).toEqual([
      ["heading", 11, 11],
      ["paragraph", 13, 13],
      ["mdxJsxFlowElement", 15, 15],
      ["mdxJsxFlowElement", 17, 17],
    ]);
    expect(result.blocks[1]?.readable).toBe("A readable paragraph.");
    expect(result.imports[0]?.identifiers).toEqual(["steps"]);
    expect(result.metadata).toEqual({
      title: "Reader example",
      type: "walkthrough",
      status: "draft",
      tags: ["example"],
    });
  });

  it("requires authored titles and validates frontmatter instead of manufacturing defaults", () => {
    expect(() => analyzeDocument("/a.mdx", "# Only heading")).toThrow(/title/);
    expect(() => analyzeDocument("/a.mdx", "---\ntitle: Test\ntags: wrong\n---\n")).toThrow(/tags/);
    expect(() => analyzeDocument("/a.mdx", "---\ntitle: [invalid\n---\n")).toThrow(
      /invalid frontmatter/,
    );
    expect(() => analyzeDocument("/a.mdx", "---\ntitle: Test\n---\n<Broken>")).toThrow(
      /cannot parse authored MDX/,
    );
  });

  it("extracts readable inline JSX, literal expressions, image descriptions, lists, and code", () => {
    const result = analyzeDocument(
      "/mixed.mdx",
      '---\ntitle: Mixed\nlayout: compact\n---\n\nText <span title="Tooltip">inline</span> {"literal expression"}.\n\n<div hidden aria-label="Label" {...{}}>Children</div>\n\n![Image description](image.png)\n\n- First\n- Second\n\n```ts\nconst example = 1\n```\n\n---\n',
    );
    expect(result.metadata.layout).toBe("compact");
    expect(result.searchText).toContain("Tooltip inline");
    expect(result.searchText).toContain("literal expression");
    expect(result.searchText).toContain("Label Children");
    expect(result.searchText).toContain("Image description");
    expect(result.searchText).toContain("First\nSecond");
    expect(result.searchText).toContain("const example = 1");
  });

  it("adds block wrappers using the same physical IDs as analysis", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-plugin-")));
    temporary.push(directory);
    await writeFile(
      join(directory, "steps.ts"),
      'export const steps = [{ title: "Hidden step" }];\n',
    );
    await writeFile(join(directory, "custom.tsx"), "export default () => <div>Custom</div>;\n");
    const path = join(directory, "example.mdx");
    await writeFile(path, document);
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks);
    const tree = await processor.run(processor.parse({ path, value: document }), {
      path,
      value: document,
    });
    const binaryTree = await processor.run(processor.parse({ path, value: document }), {
      path,
      value: new TextEncoder().encode(document),
    });
    expect(binaryTree).toEqual(tree);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain("SourceBlock");
    expect(serialized).toContain(analyzeDocument(path, document).blocks[0]?.id);
    expect(serialized).toContain("data-source-file");
    expect(serialized).toContain(
      sourceVersion(analyzeDocument(path, document).blocks[0]?.raw ?? ""),
    );
    expect(sourceVersion("before")).not.toBe(sourceVersion("after"));
    await expect(
      remarkSourceBlocks()(
        { type: "root", children: [{ type: "paragraph", children: [] }] },
        { path: "/missing-position.mdx" },
      ),
    ).rejects.toThrow(/no physical source position/);
  });

  it("resolves authored document links from physical files while preserving citation source", async () => {
    const path = "/project/docs/specs/nested/page.mdx";
    const target = "/project/docs/specs/2026-10-19-23:44-target.mdx";
    const links = [
      ["../2026-10-19-23:44-target.mdx", "/declared-target"],
      [
        "../2026-10-19-23%3A44-target.mdx?view=raw%20source#part%202",
        "/declared-target?view=raw%20source#part%202",
      ],
      ["./sibling.mdx#heading", "/declared-sibling#heading"],
      ["https://example.com/page.mdx?mode=1#part", "https://example.com/page.mdx?mode=1#part"],
      ["//example.com/page.mdx", "//example.com/page.mdx"],
      ["mailto:person@example.com", "mailto:person@example.com"],
      ["/docs/specs/target#part", "/docs/specs/target#part"],
      ["#same-page", "#same-page"],
      ["?view=raw#part", "?view=raw#part"],
      ["./missing.mdx", "./missing.mdx"],
      ["../../../packages/reader/README.md", "../../../packages/reader/README.md"],
      ["./invalid%ZZ.mdx", "./invalid%ZZ.mdx"],
      ["", ""],
    ];
    const source = `---\ntitle: Physical links\n---\n\n${links.map(([url], index) => `[Link ${index}](${url})`).join("\n\n")}\n\n[Reference][target]\n\n[target]: ../2026-10-19-23:44-target.mdx#reference\n`;
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, {
        pages: [
          { path: target, route: "/declared-target" },
          { path: "/project/docs/specs/nested/sibling.mdx", route: "/declared-sibling" },
        ],
      });
    const tree = processor.parse({ path, value: source });
    await processor.run(tree, { path, value: source });
    function destinations(node: Root | RootContent): string[] {
      return [
        ...(node.type === "link" || node.type === "definition" ? [node.url] : []),
        ...("children" in node ? node.children.flatMap((child) => destinations(child)) : []),
      ];
    }
    expect(destinations(tree)).toEqual([
      ...links.map(([, expected]) => expected),
      "/declared-target#reference",
    ]);
    const analyzed = analyzeDocument(path, source);
    expect(formatCopy({ blocks: analyzed.blocks, mode: "raw" })).toContain(
      "[Link 0](../2026-10-19-23:44-target.mdx)",
    );
    expect(JSON.stringify(tree)).toContain(analyzed.blocks[0]?.id);
  });

  it("resolves a fragment's links relative to its own physical folder", async () => {
    const path = "/project/docs/_fragments/inner/content.mdx";
    const source = "Fragment [page](../../specs/target.mdx#evidence).\n";
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, {
        pages: [{ path: "/project/docs/specs/target.mdx", route: "/declared-fragment-target" }],
      });
    const tree = await processor.run(processor.parse({ path, value: source }), {
      path,
      value: source,
    });
    expect(JSON.stringify(tree)).toContain('"url":"/declared-fragment-target#evidence"');
    expect(JSON.stringify(tree)).toContain(path);
  });

  it("copies disjoint selection references, readable state, raw source and implementation context deliberately", () => {
    const blocks = analyzeDocument("/example.mdx", document).blocks.slice(0, 2);
    const readable = formatCopy({ blocks, readable: "heading\nA readable", state: { step: 2 } });
    expect(readable).toContain("heading\nA readable");
    expect(readable).toContain("/example.mdx:11-11");
    expect(readable).toContain("/example.mdx:13-13");
    expect(readable).toContain('"step": 2');
    expect(formatCopy({ blocks, mode: "raw" })).toContain("A **readable** paragraph.");
    expect(formatCopy({ blocks, mode: "reference" })).not.toContain("Physical heading");
    expect(formatCopy({ blocks: [] })).toBe("");
    const visual = {
      ...blocks[0]!,
      contributors: [{ path: "/data.ts", startLine: 2, endLine: 2, kind: "data" as const }],
      implementations: [
        { path: "/visual.tsx", startLine: 1, endLine: 1, kind: "implementation" as const },
      ],
    };
    expect(
      formatCopy({
        blocks: [visual, visual],
        mode: "raw",
        includeImplementations: true,
        sources: {
          "/data.ts": "line 1\nreadable data\n",
          "/visual.tsx": "implementation source\n",
        },
      }),
    ).toContain("readable data");
    expect(
      formatCopy({ blocks: [visual], mode: "reference", includeImplementations: true }),
    ).toContain("visual.tsx:1-1 (implementation)");
    expect(formatCopy({ blocks: [visual], mode: "raw", sources: {} })).toContain(
      "Physical heading",
    );
  });

  it("indexes all inline exported visual data and cites its physical declaration", () => {
    const source =
      '---\ntitle: Inline data\n---\n\nexport const steps = [{ title: "Hidden inline step", body: "Longer explanation" }]\n\n<Walkthrough steps={steps} />\n';
    const result = analyzeDocument("/inline.mdx", source);
    expect(result.searchText).toContain("Hidden inline step");
    expect(result.blocks[0]?.contributors).toContainEqual({
      path: "/inline.mdx",
      startLine: 5,
      endLine: 5,
      kind: "data",
    });
  });

  it("offers shared-kit implementation context only when requested", async () => {
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Standard component\n---\n\nimport { Walkthrough } from "@tackup/reader"\n\n<Walkthrough id="example" steps={[]} />\n',
    });
    const corpus = await loadCorpus(config);
    const block = corpus[0]?.blocks[0];
    expect(block?.implementations?.[0]?.path).toMatch(/packages\/reader\/src\/visuals.tsx$/);
    expect(formatCopy({ blocks: block === undefined ? [] : [block] })).not.toContain("visuals.tsx");
    expect(
      formatCopy({ blocks: block === undefined ? [] : [block], includeImplementations: true }),
    ).toContain("visuals.tsx");
  });

  it("indexes optional static custom readable exports and cites their exact authored declaration", async () => {
    const { directory, config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Custom readable export\n---\n\nimport Custom from "./custom.tsx"\n\n<Custom />\n',
      "custom.tsx":
        "export default function Custom() { return <div>Arbitrary generated output</div>; }\n\nexport const readerReadable = `Shared readable explanation\nSecond declared line`;\n",
    });
    const first = (await loadCorpus(config))[0];
    const block = first?.blocks[0];
    expect(first?.searchText).toContain("Shared readable explanation");
    expect(first?.searchText).not.toContain("Arbitrary generated output");
    expect(block?.contributors).toContainEqual({
      path: join(directory, "reader/custom.tsx"),
      startLine: 3,
      endLine: 4,
      kind: "data",
    });
    expect(formatCopy({ blocks: block === undefined ? [] : [block] })).toContain(
      "Shared readable explanation",
    );
    await writeFile(
      join(directory, "reader/custom.tsx"),
      "export default function Custom() { return <div>Arbitrary generated output</div>; }\n\nexport const readerReadable = `Updated readable explanation\nSecond declared line`;\n",
    );
    expect((await loadCorpus(config))[0]?.blocks[0]?.version).not.toBe(block?.version);
  });

  it("resolves extensionless data directory imports without executing source", async () => {
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Imported directory\n---\n\nimport { steps } from "./data"\n\n<Walkthrough steps={steps} />\n',
      "data/index.ts":
        'throw new Error("Never execute imported data");\nexport const steps = [{ title: "Directory hidden step" }];\n',
    });
    const corpus = await loadCorpus(config);
    expect(corpus[0]?.searchText).toContain("Directory hidden step");
    expect(corpus[0]?.blocks[0]?.contributors[0]?.path).toMatch(/data\/index.ts$/);
  });

  it("keeps generated custom readable expressions optional and never evaluates them", async () => {
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Generated readable fallback\n---\n\nimport Custom from "./custom.tsx"\n\n<Custom />\n',
      "custom.tsx":
        "export const readerReadable = `Generated ${Math.random()}`;\nexport default () => <figure />;\n",
    });
    const page = (await loadCorpus(config))[0];
    expect(page?.blocks[0]?.contributors).toEqual([]);
    expect(page?.blocks[0]?.readable).toBe("");
  });

  it("terminates cyclic static data imports and ignores package implementation text", async () => {
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Cyclic source modules\n---\n\nimport { steps } from "./data.ts"\n\n<Walkthrough steps={steps} />\n',
      "data.ts": 'export const first = "Unused first";\nexport { steps } from "./steps.ts";\n',
      "steps.ts":
        'import { first } from "./data.ts";\nimport type { ReactNode } from "react";\nimport type { WalkthroughProps } from "@tackup/reader";\nexport const steps = [{ title: "Cyclic authored step" }];\n',
    });
    const page = (await loadCorpus(config))[0];
    expect(page?.searchText).toContain("Cyclic authored step");
    expect(page?.blocks[0]?.contributors).toHaveLength(2);
  });

  it("indexes and versions all steps through local data imports and reexports", async () => {
    const { directory, config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Reexported data\n---\n\nimport { steps } from "./data.ts"\n\n<Walkthrough steps={steps} />\n',
      "data.ts": 'export { steps } from "./steps.ts";\n',
      "steps.ts":
        'import { detail } from "./detail.json";\nexport const steps = [{ title: "Hidden reexported step", body: detail }];\n',
      "detail.json": '{ "detail": "Hidden third file text" }\n',
    });
    const first = await loadCorpus(config);
    expect(first[0]?.searchText).toContain("Hidden reexported step");
    expect(first[0]?.searchText).toContain("Hidden third file text");
    expect(first[0]?.blocks[0]?.contributors.map((reference) => reference.path)).toEqual(
      ["data.ts", "steps.ts", "detail.json"].map((name) => join(directory, "reader", name)),
    );
    await writeFile(
      join(directory, "reader/detail.json"),
      '{ "detail": "Changed third file text" }\n',
    );
    const second = await loadCorpus(config);
    expect(second[0]?.blocks[0]?.version).not.toBe(first[0]?.blocks[0]?.version);
  });

  it.each(["steps", "steps as chosen"])(
    "keeps data imports readable after side-effect imports: %s",
    async (binding) => {
      const { config } = await corpusFixture({
        "page.mdx": `---\ntitle: Styled document\n---\n\nimport "./style.css"\nimport { ${binding} } from "./steps.ts"\n\n<Walkthrough steps={${binding === "steps" ? "steps" : "chosen"}} />\n`,
        "style.css": "body { color: green; }\n",
        "steps.ts": 'export const steps = [{ title: "Aliased hidden step" }];\n',
      });
      expect((await loadCorpus(config))[0]?.searchText).toContain("Aliased hidden step");
    },
  );

  it.each(["type: undeclared", "status: undeclared"])(
    "validates declared metadata vocabularies: %s",
    async (field) => {
      const { config } = await corpusFixture({
        "page.mdx": `---\ntitle: Invalid vocabulary\n${field}\n---\n\nPage.\n`,
      });
      await expect(loadCorpus(config)).rejects.toThrow(/undeclared metadata/);
    },
  );

  it("fails the load when a content root is not a directory instead of reading it as empty", async () => {
    const { directory, config } = await corpusFixture({ "page.mdx": "# Page\n" });
    const file = join(directory, "reader", "page.mdx");
    await expect(
      loadCorpus({ ...config, content: config.content.map((entry) => ({ ...entry, root: file })) }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("loads document tags without a matching configuration declaration", async () => {
    const { config } = await corpusFixture({
      "page.mdx": "---\ntitle: Tagged page\ntags: [cli, automation]\n---\n\nPage.\n",
    });
    expect((await loadCorpus(config))[0]?.metadata.tags).toEqual(["cli", "automation"]);
  });

  it("reports missing relative imports and imported symlinks escaping the selected worktree", async () => {
    const { directory, config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Missing import\n---\n\nimport { data } from "./missing.ts"\n\n<Chart data={data} />\n',
    });
    await expect(loadCorpus(config)).rejects.toThrow(/imported source .* cannot be read/);
    const outside = await corpusFixture({
      "data.ts": 'export const data = [{ label: "Outside" }];',
    });
    await symlink(join(outside.directory, "reader/data.ts"), join(directory, "reader/missing.ts"));
    await expect(loadCorpus(config)).rejects.toThrow(/resolves outside the selected worktree/);
  });

  it("keeps unsupported external component imports discoverable by their host page", async () => {
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: External component host\n---\n\nimport External from "third-party-component"\n\n<External />\n',
    });
    const corpus = await loadCorpus(config);
    expect(corpus[0]?.searchText).toContain("External component host");
    expect(corpus[0]?.blocks[0]?.contributors).toEqual([]);
  });

  it("loads multiple included pages once in stable order while leaving symlink files outside the corpus", async () => {
    const { directory, config } = await corpusFixture({
      "page.mdx": "---\ntitle: Later\n---\n\nLater page.\n",
      "nested/first.mdx": "---\ntitle: Earlier\n---\n\nEarlier page.\n",
    });
    await symlink(join(directory, "reader/page.mdx"), join(directory, "reader/alias.mdx"));
    const content = { root: join(directory, "reader"), include: ["**/*.mdx"], exclude: [] };
    const corpus = await loadCorpus({ ...config, content: [content, content] });
    expect(corpus.map((page) => page.title)).toEqual(["Earlier", "Later"]);
    expect(corpus[0]?.route).toBe("/reader/nested/first");
  });

  it("passes over dot, underscore and node_modules entries and the folders of another source", async () => {
    const page = (title: string) => `---\ntitle: ${title}\n---\n\n${title}.\n`;
    const { directory, config } = await corpusFixture({
      "index.mdx": page("Welcome"),
      ".obsidian/notes.mdx": page("Hidden"),
      "_drafts/wip.mdx": page("Draft"),
      "node_modules/pkg/README.mdx": page("Package"),
      "example/tack.yaml": "version: 1\n",
      "example/docs/page.mdx": page("Example"),
      "skill/SKILL.md": "---\nname: skill\n---\n",
      "skill/tack.yaml": "version: 1\n",
      "skill/page.mdx": page("Skill content"),
    });
    const content = { root: join(directory, "reader"), include: ["**/*.mdx"], exclude: [] };
    const corpus = await loadCorpus({ ...config, content: [content] });
    expect(corpus.map(({ title }) => title)).toEqual(["Welcome", "Skill content"]);
  });

  it("indexes numeric authored chart data in inline and imported structures", async () => {
    const inline = analyzeDocument(
      "/numeric.mdx",
      '---\ntitle: Numeric data\n---\n\nexport const points = [{ label: "Setup", value: 456.25 }]\n\n<Chart data={points} />\n',
    );
    expect(inline.searchText).toContain("456.25");
    const { config } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Imported numeric data\n---\n\nimport { points } from "./points.ts"\n\n<Chart data={points} />\n',
      "points.ts": 'export const points = [{ label: "Edit", value: -321.5 }];\n',
    });
    expect((await loadCorpus(config))[0]?.searchText).toContain("-321.5");
  });

  it("maps and versions nested fragments with inline declared data", async () => {
    const { config, directory } = await corpusFixture({
      "page.mdx":
        '---\ntitle: Nested fragments\n---\n\nimport First from "./first.mdx"\n\n<First />\n',
      "first.mdx": 'import Second from "./second.mdx"\n\n<Second />\n',
      "second.mdx":
        'export const points = [{ label: "Nested value", value: 12 }]\n\n<Chart data={points} />\n',
    });
    const page = (await loadCorpus(config))[0];
    expect(page?.searchText).toContain("Nested value");
    const leaf = page?.blocks.find((block) => block.source.path.endsWith("second.mdx"));
    expect(leaf?.contributors).toContainEqual({
      path: join(directory, "reader/first.mdx"),
      startLine: 3,
      endLine: 3,
    });
    expect(leaf?.contributors).toContainEqual({
      path: join(directory, "reader/page.mdx"),
      startLine: 7,
      endLine: 7,
    });
    const value =
      'export const points = [{ label: "Nested value", value: 12 }]\n\n<Chart data={points} />\n';
    const path = join(directory, "reader/second.mdx");
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, { worktree: directory });
    expect(
      JSON.stringify(await processor.run(processor.parse({ path, value }), { path, value })),
    ).toContain(leaf?.version);
    const resolved = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, {
        worktree: (file: string) => (file === path ? directory : "/elsewhere"),
      });
    expect(
      JSON.stringify(await resolved.run(resolved.parse({ path, value }), { path, value })),
    ).toContain(leaf?.version);
  });

  it("maps fragment selections to leaf sources, data, and the containing invocation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-fragment-")));
    temporary.push(directory);
    await mkdir(join(directory, "reader"));
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        version: 1,
        content: [{ root: "reader", include: ["page.mdx"], exclude: [] }],
        navigation: { preset: "folders" },
        layouts: { preset: "reader" },
        components: { preset: "standard" },
        metadata: { preset: "working-docs" },
      }),
    );
    await writeFile(
      join(directory, "reader/page.mdx"),
      '---\ntitle: Fragment host\n---\n\nimport Fragment from "./fragment.mdx"\nimport Custom from "./custom.tsx"\n\n<Fragment />\n\n<Custom />\n',
    );
    await writeFile(
      join(directory, "reader/fragment.mdx"),
      '## Imported heading\n\nReadable imported paragraph.\n\nimport { data } from "./data.ts"\n\n<Chart data={data} />\n',
    );
    await writeFile(
      join(directory, "reader/data.ts"),
      'export const data = [{ label: "Hidden fragment data", value: 2 }];\n',
    );
    await writeFile(
      join(directory, "reader/custom.tsx"),
      "export default () => <div>Unintegrated generated content</div>;\n",
    );
    const corpus = await loadCorpus(await loadReaderConfig(directory));
    const host = corpus[0];
    const leaf = host?.blocks.find(
      (block) => block.source.path.endsWith("fragment.mdx") && block.source.startLine === 3,
    );
    expect(leaf?.contributors).toContainEqual({
      path: join(directory, "reader/page.mdx"),
      startLine: 8,
      endLine: 8,
    });
    expect(host?.searchText).toContain("Readable imported paragraph.");
    const custom = host?.blocks.find(
      (block) => block.source.path.endsWith("page.mdx") && block.source.startLine === 10,
    );
    expect(custom?.readable).toBe("");
    expect(custom?.implementations).toEqual([
      {
        path: join(directory, "reader/custom.tsx"),
        startLine: 1,
        endLine: 1,
        kind: "implementation",
      },
    ]);
    expect(formatCopy({ blocks: custom === undefined ? [] : [custom] })).not.toContain(
      "custom.tsx",
    );
    await writeFile(
      join(directory, "reader/data.ts"),
      'export const data = [{ label: "Updated fragment data", value: 3 }];\n',
    );
    const updated = await loadCorpus(await loadReaderConfig(directory));
    expect(updated[0]?.blocks[0]?.raw).toBe(host?.blocks[0]?.raw);
    expect(updated[0]?.blocks[0]?.version).not.toBe(host?.blocks[0]?.version);
    const visual = updated[0]?.blocks.find(
      (block) => block.source.path.endsWith("fragment.mdx") && block.source.startLine === 7,
    );
    const originalVisual = host?.blocks.find(
      (block) => block.source.path.endsWith("fragment.mdx") && block.source.startLine === 7,
    );
    expect(visual?.version).not.toBe(originalVisual?.version);
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, { worktree: directory });
    const value =
      '## Imported heading\n\nReadable imported paragraph.\n\nimport { data } from "./data.ts"\n\n<Chart data={data} />\n';
    const path = join(directory, "reader/fragment.mdx");
    const compiled = await processor.run(processor.parse({ path, value }), { path, value });
    expect(JSON.stringify(compiled)).toContain(visual?.version);
  });

  it("loads only explicitly included MDX, indexes hidden imported steps, maps data contributors, and reparses saved edits", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-source-")));
    temporary.push(directory);
    await mkdir(join(directory, "reader"));
    await writeFile(
      join(directory, "tack.reader.yaml"),
      stringify({
        version: 1,
        content: [{ root: "reader", include: ["**/*.mdx"], exclude: ["fragment.mdx"] }],
        navigation: { preset: "folders" },
        layouts: { preset: "reader" },
        components: { preset: "standard" },
        metadata: { preset: "working-docs", tags: ["example"] },
      }),
    );
    await writeFile(join(directory, "reader/example.mdx"), document);
    await writeFile(join(directory, "reader/legacy.md"), "# Never automatically included");
    await writeFile(join(directory, "reader/fragment.mdx"), "Excluded fragment");
    await writeFile(
      join(directory, "reader/steps.ts"),
      'export const steps = [\n { title: "Hidden second step", body: "All steps are searchable" }\n];\n',
    );
    await writeFile(
      join(directory, "reader/custom.tsx"),
      "export default function Custom() { return <div>Opaque custom</div>; }\n",
    );
    const config = await loadReaderConfig(directory);
    const first = await loadCorpus(config);
    expect(first).toHaveLength(1);
    expect(first[0]?.searchText).toContain("Hidden second step");
    const visual = first[0]?.blocks[2];
    expect(visual?.contributors).toContainEqual({
      path: join(directory, "reader/steps.ts"),
      startLine: 1,
      endLine: 3,
      kind: "data",
    });
    expect(first[0]?.blocks[3]?.contributors).toEqual([]);
    await writeFile(
      join(directory, "reader/example.mdx"),
      document.replace("# Physical heading", "\n\n# Edited heading"),
    );
    await writeFile(
      join(directory, "reader/steps.ts"),
      'export const steps = [{ title: "Updated hidden step" }];\n',
    );
    const second = await loadCorpus(config);
    expect(second[0]?.blocks[0]?.source.startLine).toBe(13);
    expect(second[0]?.searchText).toContain("Updated hidden step");
    expect(second[0]?.searchText).not.toContain("Hidden second step");
    expect(second[0]?.blocks[2]?.raw).toBe(first[0]?.blocks[2]?.raw);
    expect(second[0]?.blocks[2]?.version).not.toBe(first[0]?.blocks[2]?.version);
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks, { worktree: directory });
    const current = document.replace("# Physical heading", "\n\n# Edited heading");
    const compiled = await processor.run(
      processor.parse({ path: second[0]?.path, value: current }),
      { path: second[0]?.path, value: current },
    );
    expect(JSON.stringify(compiled)).toContain(second[0]?.blocks[2]?.version);
  });
});

describe("source blocks build digest", () => {
  const page =
    '---\ntitle: Digest page\n---\n\nimport { steps } from "./data.ts"\nimport Fragment from "./fragment.mdx"\nimport Custom from "./custom.tsx"\n\nOwn paragraph.\n\n<Walkthrough steps={steps} />\n\n<Fragment />\n\n<Custom />\n';
  const files = {
    "page.mdx": page,
    "data.ts": 'export const steps = [{ title: "Imported step" }];\n',
    "fragment.mdx": "Fragment paragraph.\n",
    "custom.tsx": "export default () => <div>Custom</div>;\n",
  };
  /** Compiles the page as the reader's build does and returns the block versions it emits. */
  async function compiledVersions(path: string) {
    const value = await readFile(path, "utf8");
    const processor = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkFrontmatter)
      .use(remarkSourceBlocks);
    const compiled = await processor.run(processor.parse({ path, value }), { path, value });
    return JSON.stringify(compiled).match(/"name":"version","value":"[^"]+"/g) ?? [];
  }

  it("changes when an imported data file changes, as the page's compiled block version does", async () => {
    const { directory, config } = await corpusFixture(files);
    const path = join(directory, "reader/page.mdx");
    const before = await sourceBlocksDigest(await loadCorpus(config));
    const compiledBefore = await compiledVersions(path);
    await writeFile(
      join(directory, "reader/data.ts"),
      'export const steps = [{ title: "Edited imported step" }];\n',
    );
    // The page's own file did not change, so Rspack alone would serve its cached block version.
    expect(await compiledVersions(path)).not.toEqual(compiledBefore);
    expect(await sourceBlocksDigest(await loadCorpus(config))).not.toBe(before);
  });

  it.each([
    {
      edited: "the page's own text",
      name: "page.mdx",
      text: page.replace("Own paragraph.", "Edited paragraph."),
      changes: false,
    },
    { edited: "a fragment", name: "fragment.mdx", text: "Edited fragment.\n", changes: true },
    // The page imports its components, so Rspack rebuilds the page when one changes.
    {
      edited: "an implementation",
      name: "custom.tsx",
      text: "export default () => <div>Edited</div>;\n",
      changes: false,
    },
  ])("changes the digest on an edit to $edited: $changes", async ({ name, text, changes }) => {
    const { directory, config } = await corpusFixture(files);
    const before = await sourceBlocksDigest(await loadCorpus(config));
    await writeFile(join(directory, "reader", name), text);
    const after = await sourceBlocksDigest(await loadCorpus(config));
    expect(after !== before).toBe(changes);
  });

  it("changes when the page routes change", async () => {
    const { config } = await corpusFixture(files);
    const documents = await loadCorpus(config);
    expect(
      await sourceBlocksDigest(documents.map((entry) => ({ ...entry, route: "/moved" }))),
    ).not.toBe(await sourceBlocksDigest(documents));
  });

  it("still digests a contributor that is gone by the time the build starts", async () => {
    const { directory, config } = await corpusFixture(files);
    const documents = await loadCorpus(config);
    const present = await sourceBlocksDigest(documents);
    await rm(join(directory, "reader/data.ts"));
    expect(await sourceBlocksDigest(documents)).not.toBe(present);
  });
});
