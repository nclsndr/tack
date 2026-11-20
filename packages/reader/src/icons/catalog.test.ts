import { describe, expect, expectTypeOf, it } from "vitest";
import {
  docsIconNames,
  iconNameIssue,
  isDocsIconName,
  searchDocsIcons,
  type DocsIconName,
} from "./catalog.ts";
import { docsIconCategories } from "./catalog.generated.ts";

describe("the docs icon names", () => {
  it("are every curated name, typed as a union the compiler checks", () => {
    expect(docsIconNames.size).toBe(docsIconCategories.flatMap(({ names }) => names).length);
    expect(isDocsIconName("house")).toBe(true);
    expect(isDocsIconName("home")).toBe(false);
    expectTypeOf<"house">().toExtend<DocsIconName>();
    expectTypeOf<"home">().not.toExtend<DocsIconName>();
  });
});

describe("iconNameIssue", () => {
  it("accepts a name from the docs set", () => {
    expect(iconNameIssue("database")).toBeUndefined();
  });

  it("names the current name of an old Lucide name", () => {
    expect(iconNameIssue("home")).toBe('unknown icon "home": Lucide renamed it "house"');
  });

  it("says when a real Lucide icon is outside the docs set, with the closest names in it", () => {
    expect(iconNameIssue("database-backup")).toBe(
      'unknown icon "database-backup": a Lucide icon outside the docs set; closest: database, database-zap',
    );
  });

  it("offers the closest names for a name Lucide does not have", () => {
    expect(iconNameIssue("chek")).toBe('unknown icon "chek"; closest: check');
    expect(iconNameIssue("Database")).toBe('unknown icon "Database"; closest: database');
  });

  it("puts the closest of several near names first", () => {
    expect(iconNameIssue("clok")).toBe('unknown icon "clok"; closest: clock, book, cloud');
  });

  it("falls back to the lookup command when nothing in the set is close", () => {
    expect(iconNameIssue("qqqqqqqqqqqq")).toBe(
      'unknown icon "qqqqqqqqqqqq"; find one with `tack docs icons <word>`',
    );
  });
});

describe("searchDocsIcons", () => {
  it("matches a word in names and in categories, and maps an old name to the current one", () => {
    expect(searchDocsIcons("folder").map(({ name }) => name)).toEqual([
      "folder",
      "folder-open",
      "folder-tree",
      "folder-plus",
      "folder-git-2",
    ]);
    expect(
      searchDocsIcons("Security").every(({ category }) => category === "Security and access"),
    ).toBe(true);
    expect(searchDocsIcons("home")).toEqual([
      { name: "house", category: "Objects and places", alias: "home" },
    ]);
  });

  it("finds nothing for an unrelated word", () => {
    expect(searchDocsIcons("qqqq")).toEqual([]);
  });

  it("finds nothing for a blank word", () => {
    expect(searchDocsIcons("  ")).toEqual([]);
  });
});
