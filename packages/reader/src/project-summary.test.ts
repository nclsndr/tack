import { describe, expect, it } from "vitest";
import {
  attachedDocs,
  firstClause,
  issueCount,
  issueEntry,
  issueLabel,
  projectMonogram,
  rootLabel,
  rootName,
} from "./project-summary.ts";
import type { ReaderDocument, ReaderResourceIssue } from "./types.ts";

describe("projectMonogram", () => {
  it.each([
    ["tack", "TK"],
    ["atlas", "AS"],
    ["a", "A"],
    ["ab", "AB"],
    ["my-app-", "MP"],
    ["platform_handbook.v2", "P2"],
    ["7", "7"],
  ])("gives %s the monogram %s", (name, monogram) => {
    expect(projectMonogram(name)).toBe(monogram);
  });

  it("keeps a name without letters or digits recognisable", () => {
    expect(projectMonogram("--")).toBe("-");
  });
});

describe("rootLabel and rootName", () => {
  it("shortens a deep root to its last three folders", () => {
    expect(rootLabel("/Users/ada/work/tmp.yDlOZzjyVi/proj")).toBe("…/work/tmp.yDlOZzjyVi/proj");
  });

  it("keeps a root of three folders or fewer whole", () => {
    expect(rootLabel("/srv/docs/atlas")).toBe("/srv/docs/atlas");
  });

  it("names the root by its own folder, ignoring a trailing slash", () => {
    expect(rootName("/Users/ada/work/atlas/")).toBe("atlas");
    expect(rootName("/")).toBe("/");
  });
});

describe("firstClause", () => {
  it.each([
    ["cannot parse authored MDX: Unexpected character `!`", "cannot parse authored MDX"],
    ["The registered source is unavailable.", "The registered source is unavailable"],
    ["Version 1.2 is not supported. Upgrade Tack.", "Version 1.2 is not supported"],
    ["first line\nsecond line", "first line"],
    [": leading colon", ": leading colon"],
  ])("cuts %j to %j", (message, clause) => {
    expect(firstClause(message)).toBe(clause);
  });
});

const handbook = { sourceRegistrationId: "source-2", name: "handbook" };
const documentIssue: ReaderResourceIssue = {
  resource: handbook,
  sourcePath: "/src/platform-handbook",
  code: "document-load",
  path: "/src/platform-handbook/handbook/rollback.mdx",
  message:
    "/src/platform-handbook/handbook/rollback.mdx: cannot parse authored MDX: Unexpected character",
};

describe("issueEntry", () => {
  it("names a skipped document by its file and states the cause without its path", () => {
    expect(issueEntry(documentIssue)).toEqual({
      name: "rollback.mdx",
      summary: "cannot parse authored MDX",
      message: documentIssue.message,
    });
  });

  it("strips a line and column the cause adds after the path", () => {
    expect(
      issueEntry({
        ...documentIssue,
        message: `${documentIssue.path ?? ""}:3:14: Expected a closing tag`,
      }).summary,
    ).toBe("Expected a closing tag");
  });

  it("keeps a cause that mentions the path further in", () => {
    expect(
      issueEntry({ ...documentIssue, message: `Cannot read ${documentIssue.path ?? ""}` }).summary,
    ).toBe(`Cannot read ${documentIssue.path ?? ""}`);
  });

  it("names an unavailable resource by its source folder and name", () => {
    expect(
      issueEntry({
        resource: handbook,
        sourcePath: "/src/platform-handbook",
        code: "docs-resource-unavailable",
        message: "The registered source is unavailable.",
      }),
    ).toEqual({
      name: "platform-handbook / handbook",
      summary: "The registered source is unavailable",
      message: "The registered source is unavailable.",
    });
  });

  it("names a resource whose source is no longer registered by the resource alone", () => {
    expect(
      issueEntry({ resource: handbook, sourcePath: "", code: "gone", message: "Gone." }).name,
    ).toBe("handbook");
  });
});

describe("issueCount", () => {
  const resourceIssue = { ...documentIssue, path: undefined, code: "resource-load" };

  it.each([
    [[], ""],
    [[documentIssue], "1 doc skipped"],
    [[documentIssue, documentIssue], "2 docs skipped"],
    [[resourceIssue], "1 resource unavailable"],
    [[resourceIssue, resourceIssue, documentIssue], "1 doc skipped · 2 resources unavailable"],
  ])("counts %# as %j", (issues, label) => {
    expect(issueCount(issues)).toBe(label);
  });
});

describe("issueLabel", () => {
  it.each([
    [[], "", ""],
    [[documentIssue], "", "1 doc skipped"],
    [[], "Compilation failed", "Rebuild failed"],
    [[documentIssue], "Compilation failed", "1 doc skipped · Rebuild failed"],
  ])("labels %# as %j", (issues, failure, label) => {
    expect(issueLabel(issues, failure)).toBe(label);
  });

  it("counts unknown icons after the skipped documents and before a failed rebuild", () => {
    const icon = { path: "/docs/a.mdx", line: 3, message: 'unknown icon "home"', suggestions: [] };
    expect(issueLabel([], "", [icon])).toBe("1 unknown icon");
    expect(issueLabel([documentIssue], "Compilation failed", [icon, icon])).toBe(
      "1 doc skipped · 2 unknown icons · Rebuild failed",
    );
    expect(issueLabel([], "", [], [icon])).toBe("1 component issue");
    expect(issueLabel([], "", [icon], [icon, icon])).toBe("1 unknown icon · 2 component issues");
  });
});

describe("attachedDocs", () => {
  const specs = {
    sourceRegistrationId: "source-1",
    name: "specs",
    sourcePath: "/work/atlas",
    directoryPath: "/work/atlas/docs/specs",
  };
  const document = (resource: typeof specs): ReaderDocument => ({
    id: resource.directoryPath,
    path: resource.directoryPath,
    relativePath: "page.md",
    route: "/page",
    title: "Page",
    metadata: { title: "Page", tags: [] },
    blocks: [],
    imports: [],
    searchText: "",
    source: "",
    resource: { ...resource, sourcePath: "/elsewhere/real-path" },
  });

  it("counts each resource's documents by its identity, keeping resources with none", () => {
    const whole = {
      ...handbook,
      sourcePath: "/src/platform-handbook",
      directoryPath: "/src/platform-handbook",
    };

    expect(attachedDocs([specs, whole], [document(specs), document(specs)])).toEqual([
      { identity: "source-1:specs", label: "atlas / specs", count: 2, directory: "docs/specs" },
      {
        identity: "source-2:handbook",
        label: "platform-handbook / handbook",
        count: 0,
        directory: ".",
      },
    ]);
  });

  it("shows a docs directory outside its source path whole", () => {
    expect(attachedDocs([{ ...specs, directoryPath: "/other/docs" }], [])[0]?.directory).toBe(
      "/other/docs",
    );
  });
});
