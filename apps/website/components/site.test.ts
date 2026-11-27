import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { pageHead, siteOrigin, siteUrl } from "./site.ts";

describe("siteUrl", () => {
  it.each([
    ["/", "https://tackup.dev/"],
    ["/features", "https://tackup.dev/features"],
    ["/docs/", "https://tackup.dev/docs/"],
    ["/features#agents", "https://tackup.dev/features#agents"],
  ])("makes %s absolute on the site's origin", (path, url) => {
    expect(siteUrl(path)).toBe(url);
  });
});

describe("pageHead", () => {
  it.each([
    ["/", "https://tackup.dev/"],
    ["/docs/getting-started", "https://tackup.dev/docs/getting-started"],
  ])("gives %s its canonical address, for search and for a shared link", (routePath, url) => {
    expect(pageHead.map((tag) => tag({ routePath }))).toEqual([
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
    ]);
  });
});

describe("robots.txt", () => {
  const robots = readFileSync(new URL("../docs/public/robots.txt", import.meta.url), "utf8");
  const lines = robots.split("\n");

  it("lets every crawler read every page", () => {
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Allow: /");
    expect(robots).not.toMatch(/^Disallow:/mu);
  });

  it("allows search, answers and training on the content", () => {
    expect(lines).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
  });

  it("names the sitemap at its absolute address", () => {
    expect(lines).toContain(`Sitemap: ${siteOrigin}/sitemap.xml`);
  });
});
