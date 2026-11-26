import { describe, expect, it } from "vitest";
import { makeDemoSession } from "./demo-shell.ts";
import {
  describeEntry,
  homeRelative,
  isWithin,
  linkEdges,
  nextFreshLinks,
  opensByDefault,
  treeOf,
  type TreeNode,
} from "./machine-view.ts";

/** The tree as indented lines: folders end with `/`, links show their target. */
const outline = (node: TreeNode, depth = 0): ReadonlyArray<string> => {
  const pad = "  ".repeat(depth);
  if (node.kind === "link") return [`${pad}${node.name} -> ${node.target}`];
  if (node.kind === "file") return [`${pad}${node.name}`];
  return [`${pad}${node.name}/`, ...node.children.flatMap((child) => outline(child, depth + 1))];
};

describe("machine view", () => {
  it("lists folders before files and hides .git", () => {
    const volume = makeDemoSession().machine().volume;

    expect(outline(treeOf(volume, "/home/you/code/app", "app"))).toEqual([
      "app/",
      "  .gitignore",
      "  README.md",
    ]);
    expect(outline(treeOf(volume, "/home/you/team-docs", "team-docs"))).toEqual([
      "team-docs/",
      "  commands/",
      "    release.md",
      "  handbook/",
      "    index.md",
      "    releases.md",
    ]);
  });

  it("shows links as leaves with their targets, keeps docs mounts and hides Tack state", async () => {
    const session = makeDemoSession();
    for (const line of [
      "tack init --adapter claude && tack source add ~/skills --config ~/skills.json --apply",
      "tack source add ~/team-docs --config ~/team-docs.json --apply",
      "cd ~/code/app && tack project add app && tack docs attach handbook && tack sync --apply",
    ])
      await session.run(line, 80);
    const volume = session.machine().volume;
    const app = treeOf(volume, "/home/you/code/app", "app");
    const home = treeOf(volume, "/home/you", "~");

    expect(outline(app).filter((line) => line.includes("->"))).toEqual([
      "      commit -> ../../../../skills/commit",
      "      review -> ../../../../skills/review",
      "        handbook -> ../../../../../team-docs/handbook",
    ]);
    expect(home.kind === "directory" ? home.children.map((child) => child.name) : []).toEqual([
      ".claude",
      ".codex",
      ".cursor",
      "code",
      "skills",
      "team-docs",
      "skills.json",
      "team-docs.json",
    ]);
    expect(linkEdges(app)).toEqual([
      { from: "/home/you/code/app/.claude/skills/commit", to: "/home/you/skills/commit" },
      { from: "/home/you/code/app/.claude/skills/review", to: "/home/you/skills/review" },
      {
        from: expect.stringMatching(/\/\.tack\/docs\/.+\/handbook$/),
        to: "/home/you/team-docs/handbook",
      },
    ]);
  });

  it("leaves dangling links out of the edges", () => {
    const volume = makeDemoSession().machine().volume;
    volume.symlink("/nowhere", "/home/you/code/app/dangling");
    const app = treeOf(volume, "/home/you/code/app", "app");

    expect(app.kind === "directory" ? app.children.map((child) => child.kind) : []).toEqual([
      "file",
      "file",
      "link",
    ]);
    expect(linkEdges(app)).toEqual([]);
  });

  it.each([
    ["/a/b", "/a", true],
    ["/a", "/a", true],
    ["/ab", "/a", false],
  ])("knows whether %s is within %s", (path, ancestor, within) => {
    expect(isWithin(path, ancestor)).toBe(within);
  });

  describe("fresh links", () => {
    const edge = (from: string) => ({ from, to: `/source${from}` });

    it("treats the starting machine as not new", () => {
      expect(nextFreshLinks(undefined, [edge("/a")]).fresh).toEqual(new Set());
    });

    it("marks the links a command added", () => {
      const start = nextFreshLinks(undefined, [edge("/a")]);

      expect(nextFreshLinks(start, [edge("/a"), edge("/b")]).fresh).toEqual(new Set(["/b"]));
    });

    it("keeps the mark while later commands leave the links alone", () => {
      const added = nextFreshLinks(nextFreshLinks(undefined, []), [edge("/a")]);
      const unchanged = nextFreshLinks(added, [edge("/a")]);

      expect(unchanged.fresh).toEqual(new Set(["/a"]));
    });

    it("clears the mark once a command removes a link and adds none", () => {
      const added = nextFreshLinks(nextFreshLinks(undefined, [edge("/a")]), [
        edge("/a"),
        edge("/b"),
      ]);

      expect(nextFreshLinks(added, [edge("/b")]).fresh).toEqual(new Set());
    });
  });

  it.each([
    ["/home/you/skills/ship", "~/skills/ship"],
    ["/home/you", "~"],
    ["/home/youth/notes", "/home/youth/notes"],
    ["/opt/tack/builtins/skills/use-tack", "/opt/tack/builtins/skills/use-tack"],
  ])("writes %s from the home as %s", (path, written) => {
    expect(homeRelative(path, "/home/you")).toBe(written);
  });

  it.each([
    ["a root folder", "/home/you/code/app", 0, [], true],
    ["a folder with nothing lit", "/home/you/code/app/.claude", 1, [], false],
    [
      "a folder leading to a lit link",
      "/home/you/code/app/.claude",
      1,
      ["/home/you/code/app/.claude/skills/ship"],
      true,
    ],
    ["a lit folder itself", "/home/you/skills/ship", 2, ["/home/you/skills/ship"], false],
    ["a sibling of a lit entry", "/home/you/code/api", 1, ["/home/you/code/app/README.md"], false],
  ])("opens %s by default: %s", (_name, path, depth, lit, open) => {
    expect(opensByDefault(path, depth, new Set(lit))).toBe(open);
  });

  describe("entry details", () => {
    it("reads a file's text and size", () => {
      const volume = makeDemoSession().machine().volume;

      const review = "/home/you/skills/review/SKILL.md";
      expect(describeEntry(volume, review)).toEqual({
        kind: "file",
        path: review,
        size: volume.stat(review).size,
        text: new TextDecoder().decode(volume.readFile(review)),
      });
    });

    it("lists a folder", () => {
      const volume = makeDemoSession().machine().volume;

      expect(describeEntry(volume, "/home/you/code")).toEqual({
        kind: "directory",
        path: "/home/you/code",
        entries: ["api", "app"],
      });
    });

    it("tells where a link points, where it resolves, and what it reaches", () => {
      const volume = makeDemoSession().machine().volume;
      volume.symlink("../../skills/commit", "/home/you/code/app/commit");
      volume.symlink("README.md", "/home/you/code/app/readme");

      expect(describeEntry(volume, "/home/you/code/app/commit")).toEqual({
        kind: "link",
        path: "/home/you/code/app/commit",
        target: "../../skills/commit",
        resolved: "/home/you/skills/commit",
        reaches: "directory",
        entries: ["SKILL.md"],
      });
      expect(describeEntry(volume, "/home/you/code/app/readme")).toMatchObject({
        reaches: "file",
        entries: [],
      });
    });

    it("reports a dangling link without a destination", () => {
      const volume = makeDemoSession().machine().volume;
      volume.symlink("/nowhere", "/home/you/dangling");

      expect(describeEntry(volume, "/home/you/dangling")).toEqual({
        kind: "link",
        path: "/home/you/dangling",
        target: "/nowhere",
        resolved: undefined,
        reaches: undefined,
        entries: [],
      });
    });

    it("reports an entry that is gone", () => {
      expect(describeEntry(makeDemoSession().machine().volume, "/home/you/gone")).toEqual({
        kind: "missing",
        path: "/home/you/gone",
      });
    });
  });
});
