import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { iconCatalogSource, readLucidePackage, type LucidePackage } from "./catalog-builder.ts";
import { curatedIcons } from "./curated.ts";

const lucide: LucidePackage = {
  version: "9.9.9",
  icons: [
    { name: "house", aliases: ["home"] },
    { name: "check", aliases: [] },
    { name: "trash", aliases: ["trash-2"] },
    { name: "zebra", aliases: [] },
  ],
};

describe("iconCatalogSource", () => {
  it("writes the curated names by category, their old names and every other Lucide name", () => {
    const source = iconCatalogSource({ Places: ["house"], Status: ["check"] }, lucide);

    expect(source).toContain('export const lucideVersion = "9.9.9";');
    expect(source).toContain('{ category: "Places", names: ["house"] }');
    expect(source).toContain('{ category: "Status", names: ["check"] }');
    expect(source).toContain('export const docsIconAliases = { "home": "house" } as const;');
    expect(source).toContain('export const otherLucideNames = "trash trash-2 zebra";');
  });

  it("refuses a curated name Lucide renamed, one it does not have and one listed twice", () => {
    expect(() =>
      iconCatalogSource({ A: ["home", "unicorn"], B: ["check", "check"] }, lucide),
    ).toThrow(
      [
        "The curated icons do not match lucide-react 9.9.9:",
        '- "home" is now "house"',
        '- "unicorn" is not a Lucide icon',
        '- "check" is listed twice',
      ].join("\n"),
    );
  });
});

describe("the generated catalog", () => {
  it("matches the curated icons and the installed Lucide; run `bun run icons:catalog`", async () => {
    const generated = await readFile(new URL("./catalog.generated.ts", import.meta.url), "utf8");

    expect(generated).toBe(iconCatalogSource(curatedIcons, await readLucidePackage()));
  });
});
