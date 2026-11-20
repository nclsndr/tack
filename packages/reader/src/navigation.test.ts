import { describe, expect, it } from "vitest";
import {
  documentAge,
  folderAncestors,
  folderLabel,
  isArchived,
  navigationTree,
  sharedFolder,
  type NavigationNode,
} from "./navigation.ts";
import type { ReaderDocument } from "./types.ts";

function doc(relativePath: string, title: string): ReaderDocument {
  return {
    id: relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    route: `/${relativePath.replace(/\.mdx$/, "")}`,
    title,
    metadata: { title, tags: [] },
    blocks: [],
    imports: [],
    searchText: "",
    source: "",
  };
}

function outline(nodes: NavigationNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === "document"
      ? node.document.title
      : { [`${node.label} (${node.count})`]: outline(node.children) },
  );
}

describe("folder navigation tree", () => {
  it("nests folders below the root, lists documents before folders, and counts every descendant", () => {
    const tree = navigationTree(
      [
        doc("docs/specs/2026-09-18-10:11-script-spec/2026-09-18-10:11-overview.mdx", "Feature"),
        doc("docs/specs/2026-09-18-10:11-script-spec/2026-09-18-10:11-phase-2.mdx", "Phase 2"),
        doc("docs/specs/2026-09-18-10:11-script-spec/2026-09-18-10:11-phase-10.mdx", "Phase 10"),
        doc("docs/specs/2026-09-22-22:44-source-spec/2026-10-18-22:15-phase-1.mdx", "Catalog"),
        doc("docs/specs/2026-09-22-22:44-source-spec/2026-09-22-22:44-overview.mdx", "Model"),
        doc("docs/ideas/notes.mdx", "Notes"),
        doc("docs/ideas/2026-10-01-early.mdx", "Early idea"),
        doc("docs/ideas/agenda.mdx", "Agenda"),
        doc("docs/2026-10-19-23:44-index.mdx", "Index"),
      ],
      "docs",
    );
    expect(outline(tree)).toEqual([
      "Index",
      { "ideas (3)": ["Early idea", "Agenda", "Notes"] },
      {
        "specs (5)": [
          { "source spec (2)": ["Catalog", "Model"] },
          { "script spec (3)": ["Feature", "Phase 2", "Phase 10"] },
        ],
      },
    ]);
    const specs = tree[2];
    expect(specs?.kind === "folder" ? specs.path : undefined).toBe("docs/specs");
  });

  it("builds from the worktree root when documents share no folder", () => {
    expect(outline(navigationTree([doc("a/one.mdx", "One"), doc("two.mdx", "Two")], ""))).toEqual([
      "Two",
      { "a (1)": ["One"] },
    ]);
  });

  it("finds the folder shared by every path", () => {
    expect(sharedFolder(["docs/a/b", "docs/a/c", "docs/a"])).toBe("docs/a");
    expect(sharedFolder(["docs/ab", "docs/a"])).toBe("docs");
    expect(sharedFolder(["docs", "notes"])).toBe("");
    expect(sharedFolder([])).toBe("");
  });

  it("lists the folders that contain a document below the tree root", () => {
    expect(folderAncestors("docs/archive/specs/one/page.mdx", "docs")).toEqual([
      "docs/archive",
      "docs/archive/specs",
      "docs/archive/specs/one",
    ]);
    expect(folderAncestors("docs/page.mdx", "docs")).toEqual([]);
    expect(folderAncestors("a/page.mdx", "")).toEqual(["a"]);
  });

  it("separates documents inside declared archive folders", () => {
    expect(isArchived(doc("docs/archive/one.mdx", "One"), ["docs/archive"])).toBe(true);
    expect(isArchived(doc("docs/archived.mdx", "Other"), ["docs/archive"])).toBe(false);
    expect(isArchived(doc("docs/one.mdx", "One"), [])).toBe(false);
  });
});

describe("navigation labels", () => {
  it("drops a folder's date stamp and reads its words", () => {
    expect(folderLabel("2026-09-16-23:45-tack-cli-core-architecture-spec")).toBe(
      "tack cli core architecture spec",
    );
    expect(folderLabel("2026-09-18-initial-grilling")).toBe("initial grilling");
    expect(folderLabel("wip")).toBe("wip");
    expect(folderLabel("2026-09-18")).toBe("2026-09-18");
  });

  it("states a dated document's age relative to today", () => {
    const today = new Date(2026, 9, 19, 23, 50);
    expect(documentAge("docs/2026-10-19-23:44-index.mdx", today)).toBe("today");
    expect(documentAge("docs/2026-10-20-future.mdx", today)).toBe("today");
    expect(documentAge("docs/2026-10-18-qa.mdx", today)).toBe("1d");
    expect(documentAge("docs/2026-09-16-00:00-spec.mdx", today)).toBe("33d");
    expect(documentAge("docs/2026-06-01-old.mdx", today)).toBe("4mo");
    expect(documentAge("docs/2023-10-01-older.mdx", today)).toBe("3y");
    expect(documentAge("docs/notes.mdx", today)).toBeUndefined();
  });
});
