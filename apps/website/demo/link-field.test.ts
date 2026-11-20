import { describe, expect, it } from "vitest";
import { agentOf, nextLinkField, placeOf, scopeOf } from "./link-field.ts";

const home = "/home/you";
const edge = (from: string, to: string) => ({ from, to });

describe("link field", () => {
  describe("agentOf", () => {
    it.each([
      ["/home/you/code/app/.claude/skills/ship", "claude"],
      ["/home/you/code/app/.agents/skills/ship", "codex"],
      ["/home/you/.codex/skills/use-tack", "codex"],
      ["/home/you/.cursor/skills/use-tack", "cursor"],
      ["/home/you/code/app/.tack/docs/8f4b/handbook", "docs"],
    ])("reads the agent of %s as %s", (path, agent) => {
      expect(agentOf(path)).toBe(agent);
    });
  });

  describe("placeOf", () => {
    it("names a project link by its project and entry, without the agent's folder", () => {
      expect(placeOf("/home/you/code/app/.claude/skills/ship", home)).toBe("~/code/app ship");
      expect(placeOf("/home/you/code/app/.cursor/skills/ship", home)).toBe("~/code/app ship");
    });

    it("names a link in the home by the home", () => {
      expect(placeOf("/home/you/.claude/skills/use-tack", home)).toBe("~ use-tack");
    });

    it("names a link outside any hidden folder by its folder", () => {
      expect(placeOf("/srv/links/ship", home)).toBe("/srv/links ship");
    });

    it("names a docs mount by its project and the docs' name", () => {
      expect(placeOf("/home/you/code/app/.tack/docs/8f4b/handbook", home)).toBe(
        "~/code/app handbook",
      );
    });
  });

  describe("scopeOf", () => {
    it("names the project or the home a link serves", () => {
      expect(scopeOf("/home/you/code/app/.claude/skills/ship", home)).toBe("~/code/app");
      expect(scopeOf("/home/you/.agents/skills/use-tack", home)).toBe("~");
    });
  });

  describe("nextLinkField", () => {
    const ship = [
      edge("/home/you/code/app/.claude/skills/ship", "/home/you/skills/ship"),
      edge("/home/you/code/app/.agents/skills/ship", "/home/you/skills/ship"),
    ];

    it("is empty on a machine without links", () => {
      expect(nextLinkField(undefined, [], new Set(), home)).toEqual({
        sources: [],
        rows: [],
      });
    });

    it("gives each real file and each place one entry, with one link per agent at the place", () => {
      const field = nextLinkField(undefined, ship, new Set(), home);
      expect(field.sources).toEqual([{ key: "/home/you/skills/ship" }]);
      expect(field.rows).toEqual([
        {
          key: "~/code/app ship",
          scope: "~/code/app",
          source: 0,
          links: [
            { key: "/home/you/code/app/.claude/skills/ship", fresh: false },
            { key: "/home/you/code/app/.agents/skills/ship", fresh: false },
          ],
        },
      ]);
    });

    it("marks the links the last command made", () => {
      const field = nextLinkField(undefined, ship, new Set([ship[1]?.from ?? ""]), home);
      expect(field.rows[0]?.links.map((link) => link.fresh)).toEqual([false, true]);
    });

    it("keeps rows where they were and adds new ones below, so nothing jumps", () => {
      const first = nextLinkField(
        undefined,
        [edge("/home/you/code/app/.claude/skills/ship", "/home/you/skills/ship")],
        new Set(),
        home,
      );
      const next = nextLinkField(
        first,
        [
          edge("/home/you/code/app/.claude/skills/commit", "/home/you/skills/commit"),
          edge("/home/you/code/app/.claude/skills/ship", "/home/you/skills/ship"),
        ],
        new Set(),
        home,
      );
      expect(next.rows.map((row) => row.key)).toEqual(["~/code/app ship", "~/code/app commit"]);
      expect(next.sources.map((source) => source.key)).toEqual([
        "/home/you/skills/ship",
        "/home/you/skills/commit",
      ]);
      expect(next.rows.map((row) => row.source)).toEqual([0, 1]);
    });

    it("drops what a command unlinked and closes the gap", () => {
      const first = nextLinkField(undefined, ship, new Set(), home);
      expect(nextLinkField(first, [], new Set(), home)).toEqual({ sources: [], rows: [] });
    });

    it("lists a place's links in the agents' order, whatever order they come in", () => {
      const field = nextLinkField(
        undefined,
        [
          edge("/home/you/.cursor/skills/use-tack", "/opt/tack/builtins/skills/use-tack"),
          edge("/home/you/.claude/skills/use-tack", "/opt/tack/builtins/skills/use-tack"),
        ],
        new Set(),
        home,
      );
      expect(field.rows[0]?.links.map((link) => agentOf(link.key))).toEqual(["claude", "cursor"]);
    });
  });
});
