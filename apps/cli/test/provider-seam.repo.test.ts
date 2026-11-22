import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });

/**
 * Code that names GitHub for a reason that is not an import provider: Tack's own releases and CI
 * live there, and the GitHub Copilot CLI agent reads skills from `.github/skills`. Everything else
 * that mentions it is the GitHub adapter or text derived from the registry.
 */
const namesGithubForOtherReasons = (module: string) =>
  module.startsWith("features/self/") ||
  module.startsWith("domain/self/") ||
  module === "cli/commands/self.ts" ||
  module === "domain/agents/agent-adapter.ts";

it("names GitHub nowhere outside its adapter, the registry, its other uses and tests", () => {
  const mentions = sourceFiles(sourceRoot)
    .filter((path) => !path.endsWith(".test.ts"))
    .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
    // The adapter, and the registry that lists it: the one place a provider is added.
    .filter(
      (module) =>
        module !== "domain/imports/providers/github.ts" &&
        module !== "domain/imports/providers/registry.ts",
    )
    .filter((module) => !module.startsWith("builtins/"))
    .filter((module) => !namesGithubForOtherReasons(module))
    .filter((module) => /github/i.test(readFileSync(resolve(sourceRoot, module), "utf8")));
  expect(mentions).toEqual([]);
});
