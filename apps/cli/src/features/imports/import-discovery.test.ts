import { expect, it } from "@effect/vitest";
import type { TreeEntry } from "../../services/import-remote.ts";
import {
  discoverSkillFolders,
  discoveryPathspecs,
  unsafeRelativePath,
} from "./import-discovery.ts";

const blob = (path: string, mode = "100644"): TreeEntry => ({
  mode,
  type: "blob",
  oid: "a".repeat(40),
  path,
});

const found = (
  paths: ReadonlyArray<string>,
  options: { readonly scope?: string; readonly fullDepth?: boolean } = {},
) =>
  discoverSkillFolders(
    paths.map((path) => blob(path)),
    options,
  ).map((folder) => `${folder.path || "."} (${folder.place})`);

it("finds skills in the documented places only", () => {
  expect(
    found([
      "skills/pdf/SKILL.md",
      "skills/.curated/docx/SKILL.md",
      "skills/.experimental/lab/SKILL.md",
      "skills/.system/core/SKILL.md",
      ".claude/skills/agent-a/SKILL.md",
      ".agents/skills/agent-b/SKILL.md",
      ".cursor/skills/agent-c/SKILL.md",
      ".opencode/skills/agent-d/SKILL.md",
      ".pi/skills/agent-e/SKILL.md",
      "other/place/SKILL.md",
      ".github/skills/agent-f/SKILL.md",
      ".gemini/skills/agent-g/SKILL.md",
      ".cline/skills/agent-h/SKILL.md",
      ".junie/skills/agent-i/SKILL.md",
      ".windsurf/skills/not-searched/SKILL.md",
      "README.md",
    ]),
  ).toEqual([
    ".agents/skills/agent-b (.agents/skills)",
    ".claude/skills/agent-a (.claude/skills)",
    ".cline/skills/agent-h (.cline/skills)",
    ".cursor/skills/agent-c (.cursor/skills)",
    ".gemini/skills/agent-g (.gemini/skills)",
    ".github/skills/agent-f (.github/skills)",
    ".junie/skills/agent-i (.junie/skills)",
    ".opencode/skills/agent-d (.opencode/skills)",
    ".pi/skills/agent-e (.pi/skills)",
    "skills/.curated/docx (skills)",
    "skills/.experimental/lab (skills)",
    "skills/.system/core (skills)",
    "skills/pdf (skills)",
  ]);
});

it("ends the search at a SKILL.md in the scope unless full depth is requested", () => {
  const paths = ["SKILL.md", "skills/pdf/SKILL.md", "deep/er/x/SKILL.md"];
  expect(found(paths)).toEqual([". (scope)"]);
  expect(found(paths, { fullDepth: true })).toEqual([
    ". (scope)",
    "deep/er/x (full depth)",
    "skills/pdf (skills)",
  ]);
});

it("treats a folder scope as the root of the search", () => {
  const paths = [
    "pack/skills/a/SKILL.md",
    "pack/b/SKILL.md",
    "skills/outside/SKILL.md",
    "pack/SKILL.md",
  ];
  expect(found(paths, { scope: "pack" })).toEqual(["pack (scope)"]);
  // A scope without a SKILL.md is searched like a skill container, and for the named places.
  expect(found(paths.slice(0, 3), { scope: "pack" })).toEqual([
    "pack/b (folder)",
    "pack/skills/a (skills)",
  ]);
  expect(found(paths.slice(0, 3), { scope: "pack", fullDepth: true })).toEqual([
    "pack/b (folder)",
    "pack/skills/a (skills)",
  ]);
  expect(found(["skills/pdf/SKILL.md"], { scope: "skills/pdf" })).toEqual(["skills/pdf (scope)"]);
  expect(found(["skills/pdf/SKILL.md"], { scope: "skills" })).toEqual(["skills/pdf (folder)"]);
});

it("walks containers three levels deep and the full-depth search five levels deep", () => {
  expect(found(["skills/a/SKILL.md", "skills/b/c/d/SKILL.md", "skills/e/f/g/h/SKILL.md"])).toEqual([
    "skills/a (skills)",
    "skills/b/c/d (skills)",
  ]);
  const deep = (levels: number) =>
    `${Array.from({ length: levels }, (_unused, index) => `d${index}`).join("/")}/SKILL.md`;
  expect(found([deep(5), deep(6)], { fullDepth: true })).toEqual(["d0/d1/d2/d3/d4 (full depth)"]);
});

it("does not look for skills inside a skill folder, and skips build and vendor folders", () => {
  expect(found(["skills/pdf/SKILL.md", "skills/pdf/examples/other/SKILL.md"])).toEqual([
    "skills/pdf (skills)",
  ]);
  expect(
    found(
      [
        "node_modules/pkg/SKILL.md",
        "dist/x/SKILL.md",
        "build/x/SKILL.md",
        "__pycache__/x/SKILL.md",
        ".git/x/SKILL.md",
        "ok/SKILL.md",
      ],
      { fullDepth: true },
    ),
  ).toEqual(["ok (full depth)"]);
});

it("excludes upstream folders named with a leading underscore and their content", () => {
  const paths = [
    "skills/_wip/x/SKILL.md",
    "skills/group/_old/y/SKILL.md",
    "skills/ok/SKILL.md",
    ".claude/skills/_hidden/SKILL.md",
    "_top/z/SKILL.md",
  ];
  expect(found(paths)).toEqual(["skills/ok (skills)"]);
  expect(found(paths, { fullDepth: true })).toEqual(["skills/ok (skills)"]);
});

it("excludes only underscore folders below the scope the operator named", () => {
  const paths = ["_pack/skills/a/SKILL.md", "_pack/_wip/b/SKILL.md", "_pack/c/SKILL.md"];
  expect(found(paths, { scope: "_pack" })).toEqual(["_pack/c (folder)", "_pack/skills/a (skills)"]);
  expect(found(["skills/_one/SKILL.md"], { scope: "skills/_one" })).toEqual([
    "skills/_one (scope)",
  ]);
  expect(found(["skills/_one/SKILL.md"], { scope: "skills" })).toEqual([]);
});

it("requires a regular file named exactly SKILL.md", () => {
  const folders = discoverSkillFolders(
    [
      blob("skills/linked/SKILL.md", "120000"),
      blob("skills/lower/skill.md"),
      blob("skills/real/SKILL.md", "100755"),
      { mode: "160000", type: "commit", oid: "b".repeat(40), path: "skills/sub/SKILL.md" },
    ],
    {},
  );
  expect(folders.map((folder) => folder.path)).toEqual(["skills/real"]);
});

it("asks the remote only for the places it searches", () => {
  expect(discoveryPathspecs({})).toEqual([
    "SKILL.md",
    "skills",
    ".claude/skills",
    ".cline/skills",
    ".agents/skills",
    ".github/skills",
    ".cursor/skills",
    ".gemini/skills",
    ".junie/skills",
    ".opencode/skills",
    ".pi/skills",
  ]);
  // A folder scope is searched as a whole: it may itself be the container of the skills.
  expect(discoveryPathspecs({ scope: "pack/x" })).toEqual(["pack/x"]);
  expect(discoveryPathspecs({ fullDepth: true })).toEqual([]);
  expect(discoveryPathspecs({ scope: "pack", fullDepth: true })).toEqual(["pack"]);
});

it("flags unsafe relative paths", () => {
  for (const path of [
    "../x",
    "a/../b",
    "/abs",
    "a//b",
    "a/./b",
    "a\\b",
    "a\u0000b",
    "",
    "a/",
    "./a",
    ".git/config",
    "a/.git/x",
  ])
    expect(unsafeRelativePath(path), JSON.stringify(path)).toBeDefined();
  for (const path of ["a", "a/b.txt", "scripts/run.sh", ".hidden/file", "a b/c"])
    expect(unsafeRelativePath(path), path).toBeUndefined();
});

it("does not list a skill scope twice when full depth also walks it", () => {
  expect(found(["pack/SKILL.md", "pack/x/SKILL.md"], { scope: "pack", fullDepth: true })).toEqual([
    "pack (scope)",
    "pack/x (folder)",
  ]);
});
