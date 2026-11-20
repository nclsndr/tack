import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtInsRoot, linkedBuiltIns, materializeBuiltIns, pruneBuiltIns } from "./release.ts";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "tack-builtins-copy-")));

it("keeps built-ins under TACK_BUILTINS_DIR, else in the home's .tack, whatever the state directory", () => {
  expect(
    builtInsRoot({ TACK_BUILTINS_DIR: "/shared/builtins", TACK_STATE_DIR: "/state" }, "/home/ada"),
  ).toBe("/shared/builtins");
  expect(builtInsRoot({ TACK_STATE_DIR: "/state" }, "/home/ada")).toBe("/home/ada/.tack/builtins");
  expect(builtInsRoot({}, undefined)).toBeUndefined();
});

it("copies a version's built-ins once, marks the copy complete and reuses it afterwards", () => {
  const root = scratch();
  const source = join(root, "package/builtins");
  mkdirSync(join(source, "skills/use-tack"), { recursive: true });
  writeFileSync(join(source, "skills/use-tack/SKILL.md"), "first\n");

  const target = materializeBuiltIns(source, join(root, "builtins"), "1.2.3");
  writeFileSync(join(source, "skills/use-tack/SKILL.md"), "changed\n");

  expect(target).toBe(join(root, "builtins/1.2.3"));
  expect(readFileSync(join(target, "skills/use-tack/SKILL.md"), "utf8")).toBe("first\n");
  expect(existsSync(join(target, ".tack-complete"))).toBe(true);
  expect(materializeBuiltIns(source, join(root, "builtins"), "1.2.3")).toBe(target);
  expect(readFileSync(join(target, "skills/use-tack/SKILL.md"), "utf8")).toBe("first\n");
});

it("replaces an incomplete copy that an interrupted first run left behind", () => {
  const root = scratch();
  const source = join(root, "package/builtins");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "tack.yaml"), "version: 1\n");
  mkdirSync(join(root, "builtins/1.2.3"), { recursive: true });
  writeFileSync(join(root, "builtins/1.2.3/partial"), "");

  const target = materializeBuiltIns(source, join(root, "builtins"), "1.2.3");

  expect(existsSync(join(target, "partial"))).toBe(false);
  expect(readFileSync(join(target, "tack.yaml"), "utf8")).toBe("version: 1\n");
});

it("finds the built-ins versions that links point into, through relative and absolute links", () => {
  const root = scratch();
  const builtins = join(root, "builtins");
  const skills = join(root, "home/.claude/skills");
  mkdirSync(join(builtins, "1.0.0/skills/use-tack"), { recursive: true });
  mkdirSync(join(builtins, "2.0.0/skills/use-tack"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  mkdirSync(skills, { recursive: true });
  symlinkSync("../../../builtins/1.0.0/skills/use-tack", join(skills, "use-tack"));
  symlinkSync(join(builtins, "2.0.0/skills/use-tack"), join(skills, "other"));
  symlinkSync(join(root, "elsewhere"), join(skills, "foreign"));
  symlinkSync(builtins, join(skills, "the-root-itself"));
  writeFileSync(join(skills, "plain.md"), "");

  expect(linkedBuiltIns(builtins, [skills, join(root, "missing")])).toEqual(
    new Set(["1.0.0", "2.0.0"]),
  );
  expect(linkedBuiltIns(join(root, "absent"), [skills])).toEqual(new Set());
});

it("prunes copies that are neither running, the newest other, nor linked", () => {
  const root = join(scratch(), "builtins");
  const copy = (version: string, at: number) => {
    mkdirSync(join(root, version), { recursive: true });
    writeFileSync(join(root, version, ".tack-complete"), "");
    utimesSync(join(root, version, ".tack-complete"), at, at);
  };
  copy("1.0.0", 1000);
  copy("2.0.0", 2000);
  copy("3.0.0", 3000);
  copy("4.0.0", 4000);
  mkdirSync(join(root, "5.0.0.staging-42"), { recursive: true });

  expect(pruneBuiltIns(root, "4.0.0", new Set(["1.0.0"]))).toEqual(["2.0.0"]);
  expect(readdirSync(root).toSorted()).toEqual(["1.0.0", "3.0.0", "4.0.0", "5.0.0.staging-42"]);
  expect(pruneBuiltIns(join(root, "absent"), "4.0.0", new Set())).toEqual([]);
});
