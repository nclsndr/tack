import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileTypeScript,
  extensionlessTarget,
  initialize,
  load,
  loadPlan,
  resolve,
} from "./script-api-loader.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scratch = async (files: Readonly<Record<string, string>>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-script-loader-")));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }),
  );
  return root;
};
const notFound = () => Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });

describe("TypeScript compilation", () => {
  it("compiles the constructs Node's type stripping refuses", () => {
    const javascript = compileTypeScript(
      [
        'import { Shape } from "./shape";',
        "enum Tone { Warm, Dry }",
        "class Greeter { constructor(private readonly name: string) {} }",
        "export const shape: Shape = { tone: Tone.Dry };",
        "export const greeter = new Greeter('Ada');",
        "export const Badge = () => <b>ok</b>;",
      ].join("\n"),
      "/source/scripts/mixed.tsx",
    );

    expect(javascript).not.toContain('from "./shape"');
    expect(javascript).toContain("Tone[Tone[");
    expect(javascript).toContain("this.name = name");
    expect(javascript).toContain("react/jsx-runtime");
  });
});

describe("resolution", () => {
  it("finds the file an extensionless relative import names", async () => {
    const root = await scratch({ "lib/util.ts": "", "lib/index.tsx": "", "data.js": "" });
    const parent = pathToFileURL(join(root, "main.ts")).href;

    expect(extensionlessTarget("./lib/util", parent)).toBe(
      pathToFileURL(join(root, "lib/util.ts")).href,
    );
    expect(extensionlessTarget("./lib", parent)).toBe(
      pathToFileURL(join(root, "lib/index.tsx")).href,
    );
    expect(extensionlessTarget("./data", parent)).toBe(pathToFileURL(join(root, "data.js")).href);
    expect(extensionlessTarget("./absent", parent)).toBeUndefined();
    expect(extensionlessTarget("package", parent)).toBeUndefined();
    expect(extensionlessTarget("./lib/util", undefined)).toBeUndefined();
  });

  it("maps the API name, retries a missing relative module, and passes everything else on", async () => {
    const root = await scratch({ "util.ts": "" });
    const parentURL = pathToFileURL(join(root, "main.ts")).href;
    initialize({ specifier: "@tackup/cli", apiUrl: "file:///tack/script.js" });
    const missing = async () => Promise.reject(notFound());

    expect(await resolve("@tackup/cli", { parentURL }, missing)).toEqual({
      url: "file:///tack/script.js",
      shortCircuit: true,
    });
    expect(await resolve("./util", { parentURL }, missing)).toEqual({
      url: pathToFileURL(join(root, "util.ts")).href,
      shortCircuit: true,
    });
    await expect(resolve("./absent", { parentURL }, missing)).rejects.toThrow("missing");
    await expect(
      resolve("./util", { parentURL }, async () => Promise.reject(new Error("other"))),
    ).rejects.toThrow("other");
    expect(await resolve("node:fs", {}, async (specifier) => ({ url: specifier }))).toEqual({
      url: "node:fs",
    });
  });
});

describe("loading", () => {
  it("compiles a script's own TypeScript, adds the JSON attribute, and leaves the rest", () => {
    expect(loadPlan("file:///source/scripts/run.ts", {})).toBe("compile");
    expect(loadPlan("file:///source/scripts/view.tsx", {})).toBe("compile");
    expect(loadPlan("file:///source/node_modules/lib/index.ts", {})).toBe("default");
    expect(loadPlan("file:///source/data.json", {})).toBe("json");
    expect(loadPlan("file:///source/data.json", { importAttributes: { type: "json" } })).toBe(
      "default",
    );
    expect(loadPlan("node:fs", {})).toBe("default");
  });

  it("returns compiled modules and asks the next loader for the others", async () => {
    const root = await scratch({ "run.ts": "export const value: number = 1;\n" });
    const seen: unknown[] = [];
    const next = async (url: string, context: object) => {
      seen.push({ url, context });
      return { format: "json", source: "{}" };
    };

    expect(await load(pathToFileURL(join(root, "run.ts")).href, {}, next)).toEqual({
      format: "module",
      source: expect.stringContaining("export const value = 1"),
      shortCircuit: true,
    });
    await load("file:///data.json", {}, next);
    await load("node:fs", {}, next);
    expect(seen).toEqual([
      { url: "file:///data.json", context: { importAttributes: { type: "json" } } },
      { url: "node:fs", context: {} },
    ]);
  });
});
