import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Schema } from "effect";
import { builtinSkills, builtinWorld } from "./support/builtin-world.ts";

const CatalogViewSchema = Schema.Struct({
  complete: Schema.Boolean,
  issues: Schema.Array(Schema.Unknown),
  resources: Schema.Array(
    Schema.Struct({ address: Schema.Struct({ name: Schema.String }), sourcePath: Schema.String }),
  ),
});
const decodeCatalog = Schema.decodeUnknownSync(CatalogViewSchema);

// Tack runs in process. The process-level smoke test is in `builtin-skills.system.test.ts`.
it("requires a global choice for ordinary skills and preserves dependency selection", async () => {
  const { run, addSkill, link } = await builtinWorld("in-process");
  const source = addSkill(
    "review",
    "metadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: git\n",
  );
  addSkill("git");
  addSkill(
    "global-default",
    "metadata:\n  tack: |\n    version: 1\n    activation: opt-in\n    user-activation: default\n",
  );
  await run(["source", "add", source, "--apply"]);
  await run(["sync", "--user", "--apply"]);
  expect(existsSync(link("review"))).toBe(false);
  expect(existsSync(link("git"))).toBe(false);
  expect(existsSync(link("global-default"))).toBe(true);
  await run(["pick", "include", "review", "--user"]);
  await run(["sync", "--user", "--apply"]);
  expect(existsSync(link("review"))).toBe(true);
  expect(existsSync(link("git"))).toBe(true);
  await run(["pick", "remove", "review", "--user"]);
  await run(["sync", "--user", "--apply"]);
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
  async (_, base) => {
    const { run, addSkill, link } = await builtinWorld("in-process", base);
    await run(["sync", "--user", "--apply"]);
    const source = addSkill("use-tack");
    await run(["source", "add", source, "--apply"]);
    const { resources, ...rest } = decodeCatalog((await run(["catalog"])).result);
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
    await run(["pick", "include", "source:use-tack", "--user"]);
    await run(["sync", "--user", "--apply"]);
    expect(realpathSync(link("use-tack"))).toBe(realpathSync(join(source, "skills/use-tack")));
    // A built-in include is refused, so it cannot create a second saved choice or a collision.
    expect(
      (await run(["pick", "include", "tack:use-tack", "--user"], 2)).diagnostics,
    ).toMatchObject([{ code: "builtin-skill-locked" }]);
    await run(["sync", "--user", "--apply"]);
    expect(realpathSync(link("use-tack"))).toBe(realpathSync(join(source, "skills/use-tack")));
    expect(existsSync(join(source, "skills/use-tack/SKILL.md"))).toBe(true);
  },
);

it.each(locations)(
  "orders the catalog by source path whichever side the fixture sorts on (%s the built-ins)",
  async (side, base) => {
    const { run, addSkill } = await builtinWorld("in-process", base);
    const source = addSkill("use-tack");
    await run(["source", "add", source, "--apply"]);
    const { resources } = decodeCatalog((await run(["catalog"])).result);
    const paths = resources.map(({ sourcePath }) => sourcePath);
    expect(paths).toEqual(
      [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    expect(new Set(paths).size).toBe(2);
    expect(paths[0] === source).toBe(side === "before");
  },
);

it("preserves a foreign file at a built-in destination", async () => {
  const { run, link } = await builtinWorld("in-process");
  mkdirSync(dirname(link("use-tack")), { recursive: true });
  writeFileSync(link("use-tack"), "operator-owned\n");
  await run(["sync", "--user", "--apply"], 1);
  expect(readFileSync(link("use-tack"), "utf8")).toBe("operator-owned\n");
  expect(lstatSync(link("use-tack", ".cursor")).isSymbolicLink()).toBe(true);
});
