import { expect, it } from "vitest";
import { inspectBundleSupport, inspectReaderBundleSupport } from "./bundle-support.ts";
import type { ArchiveEntry } from "../../domain/bundles/tar.ts";
import { nodeBundleScanner } from "../../platform/bundles/bundle-scanner.ts";

const file = (path: string, content: string): ArchiveEntry => ({
  path: `sources/source-0/${path}`,
  kind: "file",
  mode: 0o644,
  bytes: new TextEncoder().encode(content),
});
it("refuses unknown module closure while leaving supplied code inert", () => {
  for (const content of [
    "import './missing'; throw new Error('never execute')",
    "require('./missing')",
    "const name = 'missing'; import(name)",
    "export default <broken",
  ])
    expect(
      inspectBundleSupport(nodeBundleScanner, [file("run.ts", content)], [])
        .map((finding) => finding.message)
        .join(" "),
    ).toMatch(/missing|computed|syntax/);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [file("run.ts", "import './helper';"), file("helper.ts", "throw new Error('inert')")],
      [],
    ),
  ).toEqual([]);
});
it("requires explicit external package, lock and setup facts without installation", () => {
  const script = file("run.ts", "import { run } from '@scope/tool/subpath'; run();");
  const packageFile = file(
    "package.json",
    JSON.stringify({ dependencies: { "@scope/tool": "1.0.0" } }),
  );
  const lock = file("bun.lock", "lock bytes");
  expect(inspectBundleSupport(nodeBundleScanner, [script], [])).toHaveLength(1);
  expect(
    inspectBundleSupport(nodeBundleScanner, [script, packageFile], ["@scope/tool 1.0.0"]),
  ).toHaveLength(1);
  expect(inspectBundleSupport(nodeBundleScanner, [script, packageFile, lock], [])).toHaveLength(1);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [script, packageFile, lock],
      ["Install @scope/tool 1.0.0 explicitly before script run"],
    ),
  ).toEqual([]);
  expect(
    inspectBundleSupport(nodeBundleScanner, [script, file("package.json", "invalid"), lock], []),
  ).toHaveLength(1);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [
        script,
        file("package.json", JSON.stringify({ dependencies: { "@scope/tool": "workspace:*" } })),
        lock,
      ],
      ["@scope/tool"],
    ),
  ).toHaveLength(1);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [file("run.ts", "import 'node:fs'; import 'bun';")],
      [],
    ),
  ).toEqual([]);
});
it("includes Markdown assets and MDX modules without treating fenced examples as executable support", () => {
  const markdown = file(
    "docs/guide.md",
    "![diagram](../diagram.svg)\n[Other](other.md#section)\n[Web](https://example.com)\n",
  );
  expect(
    inspectBundleSupport(nodeBundleScanner, [markdown], [])
      .map((finding) => finding.message)
      .join(" "),
  ).toContain("diagram.svg");
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [markdown, file("diagram.svg", "<svg/>"), file("docs/other.md", "# Other")],
      [],
    ),
  ).toEqual([]);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [file("docs/guide.mdx", "import X from '../component.tsx';\n# Guide")],
      [],
    ),
  ).toHaveLength(1);
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [file("guide.md", "```ts\nimport './example-only';\n```\n")],
      [],
    ),
  ).toEqual([]);
});
it("requires regular reader module and content roots in the declared support inventory", () => {
  const entries = [
    file("reader.tsx", "throw new Error('inert')"),
    {
      path: "sources/source-0/docs",
      kind: "directory" as const,
      mode: 0o755,
      bytes: new Uint8Array(),
    },
  ];
  expect(
    inspectReaderBundleSupport(
      { components: { module: "reader.tsx" }, content: [{ root: "docs" }] },
      "sources/source-0/",
      entries,
    ),
  ).toEqual([]);
  expect(
    inspectReaderBundleSupport(
      { layouts: { module: "absent.tsx" }, content: [{ root: "../outside" }] },
      "sources/source-0/",
      entries,
    ),
  ).toHaveLength(2);
});

it.each([
  ["run.ts", "const name = 'helper'; import('./' + name);"],
  ["run.ts", "const name = 'helper'; require('./' + name);"],
  ["run.ts", "const name = 'helper'; import(`./${name}`);"],
  ["guide.mdx", 'import "./missing.ts";\n\n# Guide'],
  ["guide.md", "![Diagram][diagram]\n\n[diagram]: ./missing.svg\n"],
  ["guide.md", '<img src="missing.svg">\n'],
  ["guide.mdx", '<img src="missing.svg" />\n'],
])("rejects unresolved real syntax in %s: %s", (path, content) => {
  expect(
    inspectBundleSupport(nodeBundleScanner, [file(path, content)], [])
      .map((finding) => finding.message)
      .join(" "),
  ).toMatch(/computed|missing/);
});
it.each([
  "Use import(moduleName) to load a module.",
  "Use `import(moduleName)` to load a module.",
  "~~~ts\nimport(moduleName);\n~~~\n",
  "````md\n```js\nimport(moduleName);\n```\n````\n",
  "    import(moduleName);\n",
  "<!-- import(moduleName) -->\n",
])("ignores non-executable documentation examples: %s", (content) => {
  expect(inspectBundleSupport(nodeBundleScanner, [file("guide.md", content)], [])).toEqual([]);
});
it("accepts included MDX side-effect imports, reference assets and JSX/HTML references", () => {
  const docs = [
    file(
      "guide.mdx",
      'import "./helper.ts";\n\n![Diagram][diagram]\n\n[diagram]: ./image.svg\n\n<img src={"./image.svg"} />\n',
    ),
    file("plain.md", '<a href="./guide.mdx">Guide</a><img src="image.svg">\n'),
  ];
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [...docs, file("helper.ts", "throw new Error('inert');"), file("image.svg", "<svg/>")],
      [],
    ),
  ).toEqual([]);
});

it("uses the authored language grammar for TypeScript assertions and generic arrows", () => {
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [
        file(
          "run.ts",
          "const identity = <T>(value: T) => value; const label = <string>identity('ok');",
        ),
      ],
      [],
    ),
  ).toEqual([]);
});
it("checks MDX imports independently of extension casing", () => {
  expect(
    inspectBundleSupport(
      nodeBundleScanner,
      [file("guide.MDX", 'import "./missing.ts";\n\n# Guide\n')],
      [],
    ),
  ).toContainEqual(expect.objectContaining({ message: expect.stringContaining("missing.ts") }));
});
it("refuses a document link whose percent-encoding does not decode", () => {
  expect(
    inspectBundleSupport(nodeBundleScanner, [file("docs/guide.md", "[x](./bad%E0%A4%A.md)\n")], []),
  ).toEqual([
    {
      code: "profile-bundle-incomplete",
      message: "sources/source-0/docs/guide.md has an invalid support link ./bad%E0%A4%A.md.",
    },
  ]);
});
