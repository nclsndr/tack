import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeEnvelope,
  runTackSync,
  sourceEntrypoint as entrypoint,
} from "./support/tack-process.ts";

const roots: Array<string> = [];
const CatalogViewSchema = Schema.Struct({
  complete: Schema.Boolean,
  issues: Schema.Array(Schema.Unknown),
  resources: Schema.Array(
    Schema.Struct({ address: Schema.Struct({ name: Schema.String }), sourcePath: Schema.String }),
  ),
});
const decodeCatalog = Schema.decodeUnknownSync(CatalogViewSchema);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * `base` decides where the fixture lives and therefore how its source path sorts against the
 * built-in source; `.tack-builtin-test-` under `apps/cli` sorts before `apps/cli/src/builtins`.
 */
const fixture = (base = tmpdir()) => {
  const root = realpathSync(mkdtempSync(join(base, ".tack-builtin-test-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const run = (args: ReadonlyArray<string>, exitCode = 0) => {
    const ran = runTackSync(["--json", "--state-dir", join(root, "state"), ...args], {
      cwd: root,
      home,
      state: join(root, "state"),
    });
    const result = { ...ran, status: ran.exitCode };
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(exitCode);
    return decodeEnvelope(result.stdout);
  };
  const addSkill = (name: string, metadata = "") => {
    const source = join(root, "source");
    const directory = join(source, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(source, "tack.yaml"), "version: 1\nskills:\n  - path: skills\n");
    writeFileSync(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Example skill\n${metadata}---\n`,
    );
    return source;
  };
  const link = (name: string, adapter = ".agents") => join(home, adapter, "skills", name);
  run(["state", "init"]);
  run(["adapter", "enable", "claude", "codex", "cursor"]);
  return { root, home, run, addSkill, link };
};

const builtinSkills = [
  "author-tack-profiles",
  "manage-tack-sources",
  "prepare-tack-checkout",
  "use-tack",
  "write-reader-figures",
] as const;

it("discovers the bundled skills without source registration and installs them only on apply", () => {
  const { run, link } = fixture();
  expect(run(["catalog"]).result).toMatchObject({
    complete: true,
    issues: [],
    resources: builtinSkills.map((name) =>
      expect.objectContaining({
        kind: "skill",
        origin: "builtin",
        address: expect.objectContaining({ kind: "skill", name }),
        activation: "opt-in",
        userActivation: "default",
      }),
    ),
  });
  run(["sync", "--user"]);
  for (const name of builtinSkills) expect(existsSync(link(name))).toBe(false);
  run(["sync", "--user", "--apply"]);
  for (const name of builtinSkills)
    for (const adapter of [".claude", ".agents", ".cursor"]) {
      expect(lstatSync(link(name, adapter)).isSymbolicLink()).toBe(true);
      expect(isAbsolute(readlinkSync(link(name, adapter)))).toBe(false);
      expect(readFileSync(join(link(name, adapter), "SKILL.md"), "utf8")).toBe(
        readFileSync(resolve(dirname(entrypoint), `builtins/skills/${name}/SKILL.md`), "utf8"),
      );
    }
  run(["status", "--user"]);
  const skill = realpathSync(link("use-tack"));
  expect(run(["pick", "exclude", "use-tack", "--user"], 2).diagnostics).toMatchObject([
    { code: "builtin-skill-locked" },
  ]);
  run(["sync", "--user", "--apply"]);
  expect(existsSync(link("use-tack"))).toBe(true);
  expect(existsSync(link("manage-tack-sources"))).toBe(true);
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  expect(run(["pick", "remove", "use-tack", "--user"], 2).diagnostics).toMatchObject([
    { code: "builtin-skill-locked" },
  ]);
  run(["sync", "--user", "--apply"]);
  expect(existsSync(link("use-tack"))).toBe(true);
  run(["state", "reset", "--apply"]);
  for (const name of builtinSkills) expect(existsSync(link(name))).toBe(false);
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
});

it("requires a global choice for ordinary skills and preserves dependency selection", () => {
  const { run, addSkill, link } = fixture();
  const source = addSkill(
    "review",
    "metadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: git\n",
  );
  addSkill("git");
  addSkill(
    "global-default",
    "metadata:\n  tack: |\n    version: 1\n    activation: opt-in\n    user-activation: default\n",
  );
  run(["source", "add", source]);
  run(["sync", "--user", "--apply"]);
  expect(existsSync(link("review"))).toBe(false);
  expect(existsSync(link("git"))).toBe(false);
  expect(existsSync(link("global-default"))).toBe(true);
  run(["pick", "include", "review", "--user"]);
  run(["sync", "--user", "--apply"]);
  expect(existsSync(link("review"))).toBe(true);
  expect(existsSync(link("git"))).toBe(true);
  run(["pick", "remove", "review", "--user"]);
  run(["sync", "--user", "--apply"]);
  expect(existsSync(link("review"))).toBe(false);
  expect(existsSync(link("git"))).toBe(false);
});

const sourceBefore = resolve(import.meta.dirname, "..");
const locations = [
  ["after", tmpdir()],
  ["before", sourceBefore],
] as const;

it.each(locations)(
  "keeps same-name resources healthy and refuses a built-in include, with the fixture sorting %s the built-ins",
  (_, base) => {
    const { run, addSkill, link } = fixture(base);
    run(["sync", "--user", "--apply"]);
    const source = addSkill("use-tack");
    run(["source", "add", source]);
    const { resources, ...rest } = decodeCatalog(run(["catalog"]).result);
    expect(rest).toEqual({ complete: true, issues: [] });
    const names = resources.map(({ address }) => address.name).sort();
    expect(names).toEqual([
      "author-tack-profiles",
      "manage-tack-sources",
      "prepare-tack-checkout",
      "use-tack",
      "use-tack",
      "write-reader-figures",
    ]);
    expect(resources.filter(({ sourcePath }) => sourcePath === source)).toHaveLength(1);
    expect(resources.filter(({ sourcePath }) => sourcePath !== source)).toHaveLength(
      builtinSkills.length,
    );
    // The include names the source's skill; the built-in one, only default-activated, steps aside.
    run(["pick", "include", "source:use-tack", "--user"]);
    run(["sync", "--user", "--apply"]);
    expect(realpathSync(link("use-tack"))).toBe(realpathSync(join(source, "skills/use-tack")));
    // A built-in include is refused, so it cannot create a second saved choice or a collision.
    expect(run(["pick", "include", "tack:use-tack", "--user"], 2).diagnostics).toMatchObject([
      { code: "builtin-skill-locked" },
    ]);
    run(["sync", "--user", "--apply"]);
    expect(realpathSync(link("use-tack"))).toBe(realpathSync(join(source, "skills/use-tack")));
    expect(existsSync(join(source, "skills/use-tack/SKILL.md"))).toBe(true);
  },
);

it.each(locations)(
  "orders the catalog by source path whichever side the fixture sorts on (%s the built-ins)",
  (side, base) => {
    const { run, addSkill } = fixture(base);
    const source = addSkill("use-tack");
    run(["source", "add", source]);
    const { resources } = decodeCatalog(run(["catalog"]).result);
    const paths = resources.map(({ sourcePath }) => sourcePath);
    expect(paths).toEqual(
      [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(new Set(paths).size).toBe(2);
    expect(paths[0] === source).toBe(side === "before");
  },
);

it("preserves a foreign file at a built-in destination", () => {
  const { run, link } = fixture();
  mkdirSync(dirname(link("use-tack")), { recursive: true });
  writeFileSync(link("use-tack"), "operator-owned\n");
  run(["sync", "--user", "--apply"], 1);
  expect(readFileSync(link("use-tack"), "utf8")).toBe("operator-owned\n");
  expect(lstatSync(link("use-tack", ".cursor")).isSymbolicLink()).toBe(true);
});
