import { expect, it } from "@effect/vitest";
import { Result } from "effect";
import type { RefListing } from "../../services/import-remote.ts";
import { parseImportLocation } from "./import-location.ts";
import { resolveRef } from "./import-resolve.ts";

const commit = (digit: string) => digit.repeat(40);
const refs: RefListing = {
  headBranch: "main",
  headCommit: commit("a"),
  branches: new Map([
    ["main", commit("a")],
    ["feature", commit("b")],
    ["feature/install", commit("c")],
    ["release", commit("d")],
  ]),
  tags: new Map([
    ["v1.0.0", commit("e")],
    ["release", commit("f")],
    ["feature/old", commit("1")],
  ]),
};

const resolve = (text: string, listing: RefListing = refs) => {
  const parsed = parseImportLocation(text);
  if (Result.isFailure(parsed)) throw new Error(`parse ${text}: ${parsed.failure.message}`);
  return resolveRef(parsed.success, listing);
};

const summary = (text: string, listing?: RefListing) => {
  const result = resolve(text, listing);
  if (Result.isFailure(result)) return `${result.failure.code}: ${result.failure.message}`;
  const resolved = result.success;
  return [
    resolved.kind,
    resolved.request ?? "-",
    resolved.commit.slice(0, 4),
    resolved.scope ?? "-",
    resolved.tracking ? "tracking" : "pinned",
    resolved.split === undefined ? "-" : `split=${resolved.split.ref}|${resolved.split.explicit}`,
  ].join(" ");
};

it("follows the default branch and treats it as tracking", () => {
  expect(summary("github:owner/repo")).toBe("default - aaaa - tracking -");
  expect(summary("github:owner/repo/skills")).toBe("default - aaaa skills tracking -");
});

it("classifies typed refs against the remote", () => {
  expect(summary("github:owner/repo#main")).toBe("branch main aaaa - tracking -");
  expect(summary("github:owner/repo#feature/install")).toBe(
    "branch feature/install cccc - tracking -",
  );
  expect(summary("github:owner/repo#v1.0.0")).toBe("tag v1.0.0 eeee - pinned -");
  expect(summary("github:owner/repo/skills#v1.0.0")).toBe("tag v1.0.0 eeee skills pinned -");
  expect(summary(`github:owner/repo#${commit("9")}`)).toBe(`commit ${commit("9")} 9999 - pinned -`);
});

it("refuses a name that is both a branch and a tag, and names both", () => {
  const result = resolve("github:owner/repo#release");
  expect(Result.isFailure(result) && result.failure.code).toBe("import-ref-ambiguous");
  expect(Result.isFailure(result) && result.failure.message).toMatch(/branch and a tag/);
});

it("lists nearby refs when a ref is unknown", () => {
  const result = resolve("github:owner/repo#featur");
  expect(Result.isFailure(result) && result.failure.code).toBe("import-ref-not-found");
  expect(Result.isFailure(result) && result.failure.message).toMatch(/feature, feature\/install/);
  const none = resolve("github:owner/repo#zzz");
  expect(Result.isFailure(none) && none.failure.message).toMatch(/main/);
});

it("resolves the ref of a tree URL against the remote, choosing the longest match", () => {
  expect(summary("https://github.com/o/r/tree/main/skills/x")).toBe(
    "branch main aaaa skills/x tracking split=main|github:o/r/skills/x#main",
  );
  expect(summary("https://github.com/o/r/tree/feature/install/skills/x")).toBe(
    "branch feature/install cccc skills/x tracking split=feature/install|github:o/r/skills/x#feature/install",
  );
  expect(summary("https://github.com/o/r/tree/feature/skills/x")).toBe(
    "branch feature bbbb skills/x tracking split=feature|github:o/r/skills/x#feature",
  );
  expect(summary("https://github.com/o/r/tree/v1.0.0")).toBe(
    "tag v1.0.0 eeee - pinned split=v1.0.0|github:o/r#v1.0.0",
  );
  expect(summary(`https://github.com/o/r/tree/${commit("7")}/skills`)).toBe(
    `commit ${commit("7")} 7777 skills pinned split=${commit("7")}|github:o/r/skills#${commit("7")}`,
  );
});

it("fails a tree URL whose ref the remote does not have, listing nearby refs", () => {
  const result = resolve("https://github.com/o/r/tree/featur/skills");
  expect(Result.isFailure(result) && result.failure.code).toBe("import-ref-not-found");
  expect(Result.isFailure(result) && result.failure.message).toMatch(/feature/);
});

it("treats a blob URL to SKILL.md as that skill's folder", () => {
  expect(summary("https://github.com/o/r/blob/main/skills/x/SKILL.md")).toBe(
    "branch main aaaa skills/x tracking split=main|github:o/r/skills/x#main",
  );
  expect(summary("https://github.com/o/r/blob/main/SKILL.md")).toBe(
    "branch main aaaa - tracking split=main|github:o/r#main",
  );
});

it("needs a default branch for a location without a ref", () => {
  const result = resolve("github:owner/repo", { branches: new Map(), tags: new Map() });
  expect(Result.isFailure(result) && result.failure.code).toBe("import-ref-not-found");
  expect(Result.isFailure(result) && result.failure.message).toMatch(/default branch/);
});

it("refuses a tree URL whose ref is both a branch and a tag", () => {
  const result = resolve("https://github.com/o/r/tree/release/skills");
  expect(Result.isFailure(result) && result.failure.code).toBe("import-ref-ambiguous");
});

it("lists no refs when the remote has none", () => {
  const result = resolve("github:owner/repo#main", { branches: new Map(), tags: new Map() });
  expect(Result.isFailure(result) && result.failure.message).toBe(
    'The remote has no branch or tag named "main".',
  );
  expect(Result.isFailure(result) && result.failure.details).toEqual({ candidates: [] });
});
