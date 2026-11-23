import { describe, expect, it } from "vitest";

import { socialHead } from "./social-head.ts";

describe("socialHead", () => {
  const head = socialHead({ title: "A title", description: "A description." });

  it("gives the page its own title, for the tab and for a shared link", () => {
    expect(head).toContainEqual(["title", { children: "A title" }]);
    expect(head).toContainEqual(["meta", { property: "og:title", content: "A title" }]);
  });

  it("gives search and a shared link the page's own description", () => {
    expect(head).toContainEqual(["meta", { name: "description", content: "A description." }]);
    expect(head).toContainEqual([
      "meta",
      { property: "og:description", content: "A description." },
    ]);
  });
});
