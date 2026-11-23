import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommit, isShippedFile } from "./build-recipe.ts";

const checkout = dirname(import.meta.dirname);
const refusal = "Set TACK_BUILD_COMMIT to the exported commit's 7–40 character hash.";

const roots: Array<string> = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "tack-build-recipe-"));
  roots.push(root);
  return root;
};

describe("buildCommit", () => {
  it("stamps the override when it is a 7 to 40 character hexadecimal hash", () => {
    expect(buildCommit(checkout, 12, { TACK_BUILD_COMMIT: "abcdef0" })).toBe("abcdef0");
    expect(buildCommit(checkout, 7, { TACK_BUILD_COMMIT: "a".repeat(40) })).toBe("a".repeat(40));
  });

  it("refuses an empty, short, long or non-hexadecimal override", () => {
    for (const stamp of ["", "abcdef", "a".repeat(41), "ABCDEF0", "not-a-hash"])
      expect(() => buildCommit(checkout, 7, { TACK_BUILD_COMMIT: stamp })).toThrow(refusal);
  });

  // The release gate runs this suite in an export with no `.git`, so the history is built here.
  it("abbreviates HEAD to the requested length without an override", () => {
    const repository = temporaryRoot();
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync(
        "git",
        ["-C", repository, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args],
        { encoding: "utf8" },
      ).trim();
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "--message", "start");
    const head = git("rev-parse", "HEAD");

    expect(buildCommit(repository, 12, {})).toBe(head.slice(0, 12));
    expect(buildCommit(repository, 7, {})).toBe(head.slice(0, 7));
  });

  it("refuses a folder that has no Git history and no override", () => {
    expect(() => buildCommit(temporaryRoot(), 7, {})).toThrow(refusal);
  });
});

describe("isShippedFile", () => {
  it("leaves tests and test helpers behind", () => {
    for (const path of [
      "/src/routes.test.ts",
      "/src/editor.browser.test.ts",
      "/src/view.test.tsx",
      "/src/loader.test.mjs",
      "/src/react.test-support.ts",
      "/src/react.test-support.test.ts",
    ])
      expect(isShippedFile(path), path).toBe(false);
  });

  it("ships production source and the folders that hold it", () => {
    for (const path of ["/src", "/src/routes.ts", "/src/test-data.json", "/src/testing.ts"])
      expect(isShippedFile(path), path).toBe(true);
  });
});

describe("the package build", () => {
  it("fails before writing anything when the commit stamp is empty or invalid", () => {
    for (const stamp of ["", "not-a-hash"]) {
      const output = join(temporaryRoot(), "package");
      const built = spawnSync(
        process.execPath,
        [join(checkout, "scripts/build-package.ts"), output],
        {
          cwd: checkout,
          env: { ...process.env, TACK_BUILD_COMMIT: stamp },
          encoding: "utf8",
        },
      );

      expect(built.status, built.stdout + built.stderr).not.toBe(0);
      expect(built.stderr).toContain(refusal);
      expect(existsSync(output)).toBe(false);
    }
  });
});
