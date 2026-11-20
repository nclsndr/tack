import { describe, expect, it } from "vitest";
import { checkDocumentIcons, documentIconUses, iconIssues, moduleIconNames } from "./usage.ts";

const mdx = [
  "---",
  "title: Icons",
  "---",
  "",
  "# Icons",
  "",
  '<Icon name="database" /> Postgres, and inline <Icon name="home" label="Home" /> text.',
  "",
  "<Icon name={dynamic} />",
  "",
  "<Icon />",
  "",
  "```mdx",
  '<Icon name="not-scanned-in-code" />',
  "```",
].join("\n");

describe("documentIconUses", () => {
  it("finds every Icon of an MDX document with its line, and no Icon in code", () => {
    expect(documentIconUses(mdx, ".mdx")).toEqual([
      { line: 7, name: "database" },
      { line: 7, name: "home" },
      { line: 9, name: undefined },
      { line: 11, name: undefined },
    ]);
  });

  it("counts a Callout's icon as an Icon, and a Callout without one as none", () => {
    expect(
      documentIconUses('<Callout icon="rocket">Go</Callout>\n\n<Callout>Plain</Callout>', ".mdx"),
    ).toEqual([{ line: 1, name: "rocket" }]);
  });

  it("finds none in plain Markdown, which renders no components", () => {
    expect(documentIconUses('<Icon name="database" />', ".md")).toEqual([]);
  });
});

describe("iconIssues", () => {
  it("reports each unknown or unreadable name with its line and the closest names", () => {
    expect(iconIssues(documentIconUses(mdx, ".mdx"))).toEqual([
      {
        line: 7,
        name: "home",
        message: 'unknown icon "home": Lucide renamed it "house"',
        suggestions: ["house"],
      },
      {
        line: 9,
        name: undefined,
        message:
          'an Icon needs a literal name, such as name="database", so the reader can bundle it',
        suggestions: [],
      },
      {
        line: 11,
        name: undefined,
        message:
          'an Icon needs a literal name, such as name="database", so the reader can bundle it',
        suggestions: [],
      },
    ]);
  });
});

describe("checkDocumentIcons", () => {
  it("finds every unusable Icon of a document by file and line, with the closest names", () => {
    expect(checkDocumentIcons(mdx, "/docs/page.mdx")).toEqual([
      {
        path: "/docs/page.mdx",
        line: 7,
        name: "home",
        message: 'unknown icon "home": Lucide renamed it "house"',
        suggestions: ["house"],
      },
      {
        path: "/docs/page.mdx",
        line: 9,
        message:
          'an Icon needs a literal name, such as name="database", so the reader can bundle it',
        suggestions: [],
      },
      {
        path: "/docs/page.mdx",
        line: 11,
        message:
          'an Icon needs a literal name, such as name="database", so the reader can bundle it',
        suggestions: [],
      },
    ]);
  });

  it("offers the closest names of the set for a misspelled name, and checks no Markdown", () => {
    expect(checkDocumentIcons('<Icon name="chek" />', "/docs/a.mdx")).toEqual([
      {
        path: "/docs/a.mdx",
        line: 1,
        name: "chek",
        message: 'unknown icon "chek"; closest: check',
        suggestions: ["check"],
      },
    ]);
    expect(checkDocumentIcons('<Icon name="chek" />', "/docs/a.md")).toEqual([]);
  });
});

describe("moduleIconNames", () => {
  it("reads the literal icon a component module passes to Callout", () => {
    expect(moduleIconNames('<Callout kind="tip" icon="rocket">x</Callout>')).toEqual(["rocket"]);
  });

  it("reads the literal names a component module passes to Icon", () => {
    expect(
      moduleIconNames(
        'export const A = () => <><Icon name="rocket" size={20} /><Icon\n  label="x"\n  name={"bug"} /></>;',
      ),
    ).toEqual(["rocket", "bug"]);
  });
});
