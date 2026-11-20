import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { groundClasses, tintClasses, tokenClasses, tokenUtilities } from "./tokens.ts";

const source = resolve(import.meta.dirname, "..");
const packageRoot = resolve(source, "..");

/** Builds the reader's stylesheet as the engine does, with no candidate from any source file. */
async function readerStylesheet(): Promise<string> {
  const path = resolve(source, "reader.css");
  const compiler = await compile(await readFile(path, "utf8"), {
    base: source,
    loadStylesheet: async (id: string, base: string) => {
      const file = id.startsWith("tailwindcss/")
        ? resolve(packageRoot, "node_modules", id)
        : resolve(base, id);
      return { path: file, base: dirname(file), content: await readFile(file, "utf8") };
    },
  });
  return compiler.build([]);
}

const escaped = (name: string): string =>
  name.replaceAll(/[^a-z0-9-]/g, (character) => `\\${character}`);

describe("token classes for sources", () => {
  it("styles every published class even when no reader file uses it", async () => {
    const css = await readerStylesheet();
    const missing = tokenClasses.filter((name) => css.includes(`.${escaped(name)}`) === false);
    expect(missing).toEqual([]);
  });

  it("paints a colour utility with the reader's token", async () => {
    const css = await readerStylesheet();
    expect(css).toMatch(/\.stroke-pen-wash\s*\{\s*stroke: var\(--tack-pen-wash\)/);
  });

  it("publishes utilities, grounds and tints, each once", () => {
    expect(new Set(tokenClasses).size).toBe(tokenClasses.length);
    expect(tokenClasses).toEqual([...tokenUtilities, ...groundClasses, ...tintClasses]);
  });
});
