import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultReaderConfig } from "../config.ts";
import type { ReaderDocument, ReaderProjectCorpus } from "../types.ts";
import { corpusIconIssues, corpusIconNames, iconModuleSource } from "./collect.ts";

const document = (
  path: string,
  source: string,
  implementations: readonly string[] = [],
): ReaderDocument => ({
  id: path,
  path,
  relativePath: path.split("/").at(-1) ?? path,
  route: `/${path}`,
  title: path,
  metadata: { title: path, tags: [] },
  blocks: [
    {
      id: "b",
      kind: "paragraph",
      readable: "",
      raw: "",
      version: "v",
      source: { path, startLine: 1, endLine: 1 },
      contributors: [],
      implementations: implementations.map((file) => ({ path: file, startLine: 1, endLine: 1 })),
    },
  ],
  imports: [],
  searchText: "",
  source,
});

describe("corpusIconIssues", () => {
  it("lists each unusable Icon of every MDX document by path and line", () => {
    expect(
      corpusIconIssues([
        document("/docs/a.mdx", '# A\n\n<Icon name="house" /> <Icon name="home" />\n'),
        document("/docs/b.md", '<Icon name="home" />\n'),
      ]),
    ).toEqual([
      {
        path: "/docs/a.mdx",
        line: 3,
        name: "home",
        message: 'unknown icon "home": Lucide renamed it "house"',
        suggestions: ["house"],
      },
    ]);
  });
});

describe("corpusIconNames", () => {
  it("collects the docs icons the documents and their component modules name, once each", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tack-icon-names-"));
    const component = join(directory, "callout.tsx");
    const navigation = join(directory, "navigation.tsx");
    await writeFile(component, 'export const Callout = () => <Icon name="rocket" />;\n');
    await writeFile(navigation, 'export const Navigation = () => <Icon name={"folder"} />;\n');
    const corpus: ReaderProjectCorpus = {
      documents: [
        document(
          "/docs/a.mdx",
          '<Icon name="house" /> <Icon name="home" /> <Icon name="house" />',
          [component, join(directory, "missing.tsx")],
        ),
      ],
      resources: [
        {
          resource: {
            sourceRegistrationId: "s",
            name: "docs",
            sourcePath: directory,
            directoryPath: directory,
          },
          documents: [],
          issues: [],
          config: {
            ...defaultReaderConfig(directory, directory),
            navigation: { module: navigation },
          },
        },
      ],
      issues: [],
      complete: true,
    };

    expect(await corpusIconNames(corpus)).toEqual(["folder", "house", "rocket"]);
  });
});

describe("iconModuleSource", () => {
  it("imports each named icon from its own Lucide module and maps names to them", () => {
    expect(iconModuleSource(["git-branch", "house"], "/lucide/icons")).toBe(
      [
        "// The docs icons this reader generation draws, imported one module each.",
        'import icon0 from "/lucide/icons/git-branch.mjs";',
        'import icon1 from "/lucide/icons/house.mjs";',
        "",
        'export const icons = { "git-branch": icon0, "house": icon1 };',
        "",
      ].join("\n"),
    );
  });

  it("exports an empty map when no document draws an icon", () => {
    expect(iconModuleSource([], "/lucide/icons")).toBe(
      [
        "// The docs icons this reader generation draws, imported one module each.",
        "",
        "export const icons = {  };",
        "",
      ].join("\n"),
    );
  });
});
