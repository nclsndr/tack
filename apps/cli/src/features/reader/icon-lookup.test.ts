import { describe, expect, it } from "vitest";
import { lookUpDocsIcons } from "./icon-lookup.ts";

describe("lookUpDocsIcons", () => {
  it("groups the matching docs icons by category, with the Lucide version they come from", () => {
    const lookup = lookUpDocsIcons("home");
    expect(lookup).toEqual({
      query: "home",
      lucideVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      count: 1,
      categories: [{ category: "Objects and places", icons: [{ name: "house", alias: "home" }] }],
    });
  });

  it("lists the whole set by category without a word", () => {
    const lookup = lookUpDocsIcons(undefined);
    expect(lookup).not.toHaveProperty("query");
    expect(lookup.count).toBeGreaterThan(200);
    expect(lookup.categories[0]?.icons[0]).toEqual({ name: "check" });
  });

  it("finds nothing for an unrelated word", () => {
    expect(lookUpDocsIcons("qqqq")).toMatchObject({ count: 0, categories: [] });
  });
});
